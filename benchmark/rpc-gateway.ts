import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionResult, multicall3Abi } from "viem";
import { base } from "viem/chains";

/**
 * A mock ETH gateway: a real JSON-RPC-over-HTTP server the benchmark's viem client talks to
 * with **viem's defaults** — one HTTP POST per `readContract`/`getBlockNumber` (no transport
 * batching, no `batch.multicall`), `retryCount: 3`, 10s timeout. That is what makes the gate
 * reads' cost REAL in the bench: the old in-process stub answered in ~0ms and bypassed viem
 * entirely, hiding the one-read-per-wallet cold-join cliff this gateway exists to expose.
 *
 * Fidelity knobs and behaviour:
 *   - `latencyMs` is charged once per HTTP request before answering — the simulated RTT +
 *     gateway processing of a public endpoint (`mainnet.base.org`-shaped). A multicall3
 *     `aggregate3` therefore costs ONE latency charge for N inner reads, which is exactly the
 *     economics the batched `evaluateMany` path exploits.
 *   - `eth_call` answers ERC-721 `balanceOf` with a fixed balance (default 1, ≥ the bench
 *     criteria's `min: 1`, so every seeded wallet passes the gate), both directly and inside a
 *     multicall3 `aggregate3` to the chain's multicall3 deployment.
 *   - `eth_blockNumber` pins the head to the bench's fixed bucket; `eth_getBlockByNumber`
 *     serves a stub block (the tally reads it only to break ties).
 *   - Every request is logged (`requests`) with its method and, for multicalls, the inner read
 *     count — the "gate RPC calls" column in RESULTS.md comes from this log.
 */

export interface GatewayRequest {
    method: string;
    /** For an `eth_call`: 1 for a direct read, the inner call count for a multicall3 aggregate3. */
    reads: number;
    /** `performance.now()` when the request arrived (before the latency charge). */
    atMs: number;
}

export interface RunningGateway {
    url: string;
    /** Every JSON-RPC request served, in arrival order. */
    requests: GatewayRequest[];
    stop(): Promise<void>;
}

export interface GatewayOptions {
    /** Charged once per HTTP request (simulated WAN RTT + gateway processing). Default 270. */
    latencyMs?: number;
    /** The `balanceOf` every wallet reads back (default 1n — passes the bench gate's min 1). */
    balance?: bigint;
    /** The fixed chain head (default 43200 — bucket 1 of the bench criteria). */
    headBlock?: bigint;
}

const MULTICALL3 = base.contracts.multicall3.address.toLowerCase();

/** A minimal but viem-parseable block for `eth_getBlockByNumber`. */
function stubBlock(numberHex: string): Record<string, unknown> {
    return {
        hash: `0x${"11".repeat(32)}`,
        parentHash: `0x${"22".repeat(32)}`,
        number: numberHex,
        timestamp: "0x0",
        nonce: `0x${"00".repeat(8)}`,
        difficulty: "0x0",
        gasLimit: "0x1c9c380",
        gasUsed: "0x0",
        miner: `0x${"00".repeat(20)}`,
        extraData: "0x",
        logsBloom: `0x${"00".repeat(256)}`,
        mixHash: `0x${"00".repeat(32)}`,
        receiptsRoot: `0x${"00".repeat(32)}`,
        sha3Uncles: `0x${"00".repeat(32)}`,
        size: "0x0",
        stateRoot: `0x${"00".repeat(32)}`,
        transactionsRoot: `0x${"00".repeat(32)}`,
        baseFeePerGas: "0x0",
        transactions: [],
        uncles: []
    };
}

export async function startRpcGateway(options: GatewayOptions = {}): Promise<RunningGateway> {
    const latencyMs = options.latencyMs ?? 270;
    const balance = options.balance ?? 1n;
    const headBlock = options.headBlock ?? 43_200n;
    const requests: GatewayRequest[] = [];

    const balanceWord = encodeAbiParameters([{ type: "uint256" }], [balance]);

    /** Answer one JSON-RPC request object, recording it. */
    function answer(rpc: { id?: unknown; method?: string; params?: unknown[] }): Record<string, unknown> {
        const method = rpc.method ?? "unknown";
        const reply = (result: unknown): Record<string, unknown> => ({ jsonrpc: "2.0", id: rpc.id ?? null, result });
        let reads = 0;

        let result: unknown;
        switch (method) {
            case "eth_chainId":
                result = `0x${base.id.toString(16)}`;
                break;
            case "eth_blockNumber":
                result = `0x${headBlock.toString(16)}`;
                break;
            case "eth_getBlockByNumber": {
                const tag = (rpc.params?.[0] as string | undefined) ?? "latest";
                result = stubBlock(tag.startsWith("0x") ? tag : `0x${headBlock.toString(16)}`);
                break;
            }
            case "eth_call": {
                const call = rpc.params?.[0] as { to?: string; data?: `0x${string}` } | undefined;
                if (call?.to?.toLowerCase() === MULTICALL3 && call.data) {
                    // One aggregate3 = many inner reads for one latency charge (the batched path).
                    const { functionName, args } = decodeFunctionData({ abi: multicall3Abi, data: call.data });
                    if (functionName !== "aggregate3") throw new Error(`unsupported multicall3 function ${functionName}`);
                    const calls = args[0] as readonly unknown[];
                    reads = calls.length;
                    result = encodeFunctionResult({
                        abi: multicall3Abi,
                        functionName: "aggregate3",
                        result: calls.map(() => ({ success: true, returnData: balanceWord }))
                    });
                } else {
                    // A direct `balanceOf` read — the unbatched path, one latency charge per wallet.
                    reads = 1;
                    result = balanceWord;
                }
                break;
            }
            default:
                return { jsonrpc: "2.0", id: rpc.id ?? null, error: { code: -32601, message: `method ${method} not mocked` } };
        }
        requests.push({ method, reads, atMs: performance.now() });
        return reply(result);
    }

    const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk: Buffer) => chunks.push(chunk));
        req.on("end", () => {
            setTimeout(() => {
                try {
                    const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                    // viem's default http transport sends one request per call; arrays appear only
                    // if a host opts into transport batching — support both shapes.
                    const payload = Array.isArray(body) ? body.map(answer) : answer(body as Parameters<typeof answer>[0]);
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify(payload));
                } catch (err) {
                    res.writeHead(500, { "content-type": "application/json" });
                    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32603, message: String(err) } }));
                }
            }, latencyMs);
        });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`,
        requests,
        stop: () =>
            new Promise<void>((resolve, reject) => {
                server.closeAllConnections?.();
                server.close((err) => (err ? reject(err) : resolve()));
            })
    };
}
