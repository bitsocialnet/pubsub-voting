# Changelog

## [0.0.3](https://github.com/bitsocialnet/pubsub-voting/compare/v0.0.2...v0.0.3) (2026-07-14)

### Features

* **schema:** export deriveDirectoryCriteria for directory manifests ([be03365](https://github.com/bitsocialnet/pubsub-voting/commit/be03365ffc5f3b38c98e75657ecbfd71cd2d3c6e))
* **transport:** announce provider records to HTTP routers from the seeder ([b472d2f](https://github.com/bitsocialnet/pubsub-voting/commit/b472d2f059d3c812e526117efbad569cc2d66b25)), closes [#6](https://github.com/bitsocialnet/pubsub-voting/issues/6)

## [0.0.2](https://github.com/bitsocialnet/pubsub-voting/compare/v0.0.1...v0.0.2) (2026-07-12)

### Reverts

* Revert "feat(schema): export deriveDirectoryCriteria for directory manifests" ([b28dc1a](https://github.com/bitsocialnet/pubsub-voting/commit/b28dc1a40c4d769cedd36cc33c1fdd97082f7469))

## 0.0.1 (2026-07-12)

### ⚠ BREAKING CHANGES

* **verify:** CommunityTally.verified is replaced by chainVerified +
nameResolved; TallyOptions/verifyBudget are removed (getTally() takes no
options); RootChaserDeps takes verifyOffline/deferVerify instead of
verifier; VoteCrdt gains currentEntries/remove and prune returns the
removed CIDs. No wire change — bundle, message, and checkpoint layouts
(and their frozen vectors) are untouched.
* **client:** address contests by criteria document; drop the manifest

### refactor

* **client:** address contests by criteria document; drop the manifest ([ef788e7](https://github.com/bitsocialnet/pubsub-voting/commit/ef788e7034e72ccca9153c280fc8155b7d9ac9eb))

### Features

* **api:** type PubsubVoter manifest option as DirectoryManifest ([86097cc](https://github.com/bitsocialnet/pubsub-voting/commit/86097ccd06ecc3a9a7da1a6bb75c17c135abcb01))
* **bench:** measure START→ALL-VERIFIED in the directory cold-load bench ([943b12f](https://github.com/bitsocialnet/pubsub-voting/commit/943b12f1c78432bb350298998f89937acd0604e4))
* board is { name?, publicKey }; strict B58 IPNS identity ([2e451eb](https://github.com/bitsocialnet/pubsub-voting/commit/2e451eb2bc288d245eff7573f4b89cdcc67ddaec))
* board names are verified claims; pairwise-distinct boards per bundle ([5ebdc76](https://github.com/bitsocialnet/pubsub-voting/commit/5ebdc761a3a8daaf90a7f377ca20a1d908f5a269)), closes [bso-resolver#3](https://github.com/bitsocialnet/bso-resolver/issues/3)
* **checkpoint:** on-demand encode + root heartbeat + directed-bitswap chase ([aaac950](https://github.com/bitsocialnet/pubsub-voting/commit/aaac9503699cad9bc7fac6c36568e5727fba817c))
* **client:** implement republish scheduler, durable persistence, and withdrawal semantics ([e85c80d](https://github.com/bitsocialnet/pubsub-voting/commit/e85c80db74b1b85defa8226a1587ba6f16f68e9f))
* **client:** make voter.destroy() terminal, mirroring pkc-js ([47e7558](https://github.com/bitsocialnet/pubsub-voting/commit/47e755856b9b80c978a7db339698acae5938fc8f)), closes [#engines](https://github.com/bitsocialnet/pubsub-voting/issues/engines)
* **client:** persist gate results and name resolutions under dataPath ([fe97719](https://github.com/bitsocialnet/pubsub-voting/commit/fe97719c5b53a0a7bb5d8bade5d043fede589da5))
* **client:** require manifest, rename contest→contestId, add getContest ([1afbea5](https://github.com/bitsocialnet/pubsub-voting/commit/1afbea5b865b8d87e158c1e236da53d0b4ec651c))
* **client:** surface publish peer-reach as recipientCount ([9f559f2](https://github.com/bitsocialnet/pubsub-voting/commit/9f559f220f3863030c9c45e1322d95c763228aa4))
* **crdt:** read-time expiry filter so decayed votes can't pollute heads ([eb7ed97](https://github.com/bitsocialnet/pubsub-voting/commit/eb7ed976a6d409ea692bcd7f3197c5f8fe3820d8))
* freeze v1 EIP-712 ballot layout with a conformance vector ([463941c](https://github.com/bitsocialnet/pubsub-voting/commit/463941caadbab8664419c51052824c6d407b85a4))
* **gate:** anti-amplification caches + network-free checkpoints ([e92d241](https://github.com/bitsocialnet/pubsub-voting/commit/e92d241420874c6302141aeed7ca0b8fcbc03945))
* **gate:** bound verdict cache + per-fetch abort against amplification ([064e04b](https://github.com/bitsocialnet/pubsub-voting/commit/064e04b7397f9a816c289c1c63f83fa4114927aa))
* implement encoding/topic/manifest foundation + PubsubVoter facade ([21f3c45](https://github.com/bitsocialnet/pubsub-voting/commit/21f3c454f6f114b7ad3ff7a5cf1eb5f1d4cf9ae2))
* interpreter scores are exact bigint via { score } result ([6351c53](https://github.com/bitsocialnet/pubsub-voting/commit/6351c53acae8a94b585df67d59bbbcb10df0738e))
* **schema:** export deriveDirectoryCriteria for directory manifests ([9a03c42](https://github.com/bitsocialnet/pubsub-voting/commit/9a03c4233431784f4ba47ee5ea209622e86e4ef7))
* single-kind interpreter registry (one file per type) ([f2790ba](https://github.com/bitsocialnet/pubsub-voting/commit/f2790ba84d5513be49984caba991f53324eba405))
* take host Helia node directly; validate pubsub + blockstore at construction ([23a4200](https://github.com/bitsocialnet/pubsub-voting/commit/23a4200d57c4a5c7bbbfa263ad750cb2f0809157))
* **transport:** cold-start discovery via HTTP content router; fix fetch key bytes ([4a302a9](https://github.com/bitsocialnet/pubsub-voting/commit/4a302a99d1bdf9a8fb201cdbb41be2f5fbc50319))
* **transport:** libp2p-fetch root-record pull — responder, cold join, MissingFetchError ([3495b36](https://github.com/bitsocialnet/pubsub-voting/commit/3495b36e6e854d4afb495fd1269cc9ab5c25c9bf))
* **transport:** live-delta gossip — inline bundles + root records, no gate fetch ([a82de02](https://github.com/bitsocialnet/pubsub-voting/commit/a82de02df72d7170bc4011ed36be78bdea2d30de)), closes [#2](https://github.com/bitsocialnet/pubsub-voting/issues/2)
* validate-before-forward gossip gate + engine (verify/crdt/tally/transport) ([d1d4e96](https://github.com/bitsocialnet/pubsub-voting/commit/d1d4e969aa446f4210e23aa1e020a8fcd5d9e5df))
* **verify:** defer cold-join chain checks to a batched background verifier ([4afc6d7](https://github.com/bitsocialnet/pubsub-voting/commit/4afc6d7690fce9d71f1c0d7f0bad0f6b44275f7d))
* voter lifecycle (start/stop/destroy), republish cadence, and dataPath persistence ([2820bad](https://github.com/bitsocialnet/pubsub-voting/commit/2820badcac1901e7df4bf3dd9bba99aa0295f853))
* **wire:** binary bundle block encoding + 253-byte name bound ([a133603](https://github.com/bitsocialnet/pubsub-voting/commit/a1336034bc9e941e54585dbe9c09654476776a1a))

### Bug Fixes

* **client:** fetch responder answers only joined topics ([a8156ef](https://github.com/bitsocialnet/pubsub-voting/commit/a8156ef9fd717f4f5fd0c6c70ab584ce075587bd))
* **client:** re-purge persisted gate results as the expiry horizon advances ([f0c346d](https://github.com/bitsocialnet/pubsub-voting/commit/f0c346dfd279ff644447130ce2d19ab4a96d0d7a))
* **client:** retry cold-start root-record fetch until a deadline ([2285f5e](https://github.com/bitsocialnet/pubsub-voting/commit/2285f5e70bb998f2af9e0fc5977e13c73e4f1ec5)), closes [#fetchRootWithRetry](https://github.com/bitsocialnet/pubsub-voting/issues/fetchRootWithRetry)
* **gate:** split forward-gate verdicts into reject vs ignore ([505eced](https://github.com/bitsocialnet/pubsub-voting/commit/505ecedf4794c2fb1d2f0232862fde15d4c12eb1))
* **storage:** reconcile the browser LRU's size counter before swapping ([ff12a19](https://github.com/bitsocialnet/pubsub-voting/commit/ff12a19116cbb8026c06b1c4edb49acd1fe994ab))

### Performance Improvements

* **benchmark:** dial seeder directly over WAN instead of an SSH tunnel ([6f78511](https://github.com/bitsocialnet/pubsub-voting/commit/6f78511252c0e3d982e249143a18a15d51e43c68))
* **client:** budget cold-start fetches per peer and shuffle subscriber pick ([647348c](https://github.com/bitsocialnet/pubsub-voting/commit/647348c925f933aaf95d474c0f4b56f10eb879c5))
* **transport:** pull checkpoint in one bitswap round-trip via piggybacked chunk index ([0393994](https://github.com/bitsocialnet/pubsub-voting/commit/0393994b01d1f10131e5b7dbffb5e917decbb001))
