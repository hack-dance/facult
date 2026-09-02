## [2.29.2](https://github.com/hack-dance/fclt/compare/v2.29.1...v2.29.2) (2026-07-29)

### Bug Fixes

* block active destination state writers ([4a079e5](https://github.com/hack-dance/fclt/commit/4a079e51261431e38363740bca3147dd18ecf8c5))
* close reconciliation authority gaps ([5b90056](https://github.com/hack-dance/fclt/commit/5b9005621de9c0f5eb0fab617a59d6d93ef44fe7))
* close reconciliation migration races ([33e6b53](https://github.com/hack-dance/fclt/commit/33e6b5383ff7828406ee26884debf65020653625))
* harden reconciliation recovery state ([654c705](https://github.com/hack-dance/fclt/commit/654c705db2292770ee6ebd6f7e4a94d01eb7fe3d))
* invalidate stale reconciliation proof ([c7d9464](https://github.com/hack-dance/fclt/commit/c7d94640296aa45e3cdb949e81a2fdd301c8d282))
* preserve exclusive recovery ordering ([6b5a29f](https://github.com/hack-dance/fclt/commit/6b5a29fc6300b1cac64f601529407bf996443f81))
* preserve live legacy lock owners ([a95c96e](https://github.com/hack-dance/fclt/commit/a95c96e0bf264f2dab3b077c3a0d10c8aa0a6bc1))
* prevent stale proof resurrection ([c452df0](https://github.com/hack-dance/fclt/commit/c452df0bc37e96d45dfa984d58489714c6cec3ad))
* serialize stale recovery and migration guards ([3253a80](https://github.com/hack-dance/fclt/commit/3253a80e940d891b6668d64eae09ff7360c60dcb))

### Performance Improvements

* batch containment rechecks ([fce5cb2](https://github.com/hack-dance/fclt/commit/fce5cb2c05a7b789fff255fc3f6e63964905d8df))

## [2.29.1](https://github.com/hack-dance/fclt/compare/v2.29.0...v2.29.1) (2026-07-29)

### Bug Fixes

* make reconciliation recovery durable ([#74](https://github.com/hack-dance/fclt/issues/74)) ([d7c7feb](https://github.com/hack-dance/fclt/commit/d7c7feb3680080d13a486905a125b4bb3d146a1e))

## [2.29.0](https://github.com/hack-dance/fclt/compare/v2.28.0...v2.29.0) (2026-07-29)

### Features

* add safe guided project onboarding ([#73](https://github.com/hack-dance/fclt/issues/73)) ([7b13e2f](https://github.com/hack-dance/fclt/commit/7b13e2f0487044530cfccbe9dda211f2e7f0aaf1))

## [2.28.0](https://github.com/hack-dance/fclt/compare/v2.27.2...v2.28.0) (2026-07-15)

### Features

* add immutable per-asset deployment planning ([818881b](https://github.com/hack-dance/fclt/commit/818881b782397cdcb0504c4485d02f2d33414193))

### Bug Fixes

* canonicalize deployment destination identity ([514a10c](https://github.com/hack-dance/fclt/commit/514a10ce09d30a6f8ac4223e49eeda3586ab10c0))
* close deployment planning races ([56aecd7](https://github.com/hack-dance/fclt/commit/56aecd77cb496f17f5e0e33583f96e32da571c37))
* harden deployment path identity ([6b28a33](https://github.com/hack-dance/fclt/commit/6b28a33537f287226174133068a23699d6aff85b))
* harden immutable deployment state scans ([36e6865](https://github.com/hack-dance/fclt/commit/36e686595be5c93ca7cc7bc39c81cad809eeaffc))
* preserve deployment ownership lifecycle ([0cbea75](https://github.com/hack-dance/fclt/commit/0cbea75d7db5e8edc72a292d84c21113bdc590a7))
* reuse hardened descriptor helpers for deploy plans ([5a18070](https://github.com/hack-dance/fclt/commit/5a180709d3086b98f4f6383ef3b87278b72e3717))

## [2.27.2](https://github.com/hack-dance/fclt/compare/v2.27.1...v2.27.2) (2026-07-15)

### Bug Fixes

* **audit:** bind MCP remediation commit ([11538f7](https://github.com/hack-dance/fclt/commit/11538f7c5588affc288724a20dc26f931a550c43))

## [2.27.1](https://github.com/hack-dance/fclt/compare/v2.27.0...v2.27.1) (2026-07-15)

### Bug Fixes

* flush large activity output ([#72](https://github.com/hack-dance/fclt/issues/72)) ([feee9de](https://github.com/hack-dance/fclt/commit/feee9de82bf8cfde24ddf42929452d84fe80e79a))

## [2.27.0](https://github.com/hack-dance/fclt/compare/v2.26.0...v2.27.0) (2026-07-15)

### Features

* add durable activity history ([#62](https://github.com/hack-dance/fclt/issues/62)) ([1a0080e](https://github.com/hack-dance/fclt/commit/1a0080e40c73971cf72b5d267348b64ce26d500f))

## [2.26.0](https://github.com/hack-dance/fclt/compare/v2.25.4...v2.26.0) (2026-07-15)

### Features

* **activity:** add safe action locators ([#63](https://github.com/hack-dance/fclt/issues/63)) ([693d2ac](https://github.com/hack-dance/fclt/commit/693d2ac71cbe95c8c24f6baec9b5a4359e61113c))

## [2.25.4](https://github.com/hack-dance/fclt/compare/v2.25.3...v2.25.4) (2026-07-15)

### Bug Fixes

* publish npm provenance on GitHub runner ([b83a8d7](https://github.com/hack-dance/fclt/commit/b83a8d76635ad745c0a673258646f0b6d332f54a))

## [2.25.3](https://github.com/hack-dance/fclt/compare/v2.25.2...v2.25.3) (2026-07-15)

### Bug Fixes

* bind Darwin x64 directory stream ABI ([65d92d3](https://github.com/hack-dance/fclt/commit/65d92d35d036c352fc3a4213e11e84a3b8297f9a))

## [2.25.2](https://github.com/hack-dance/fclt/compare/v2.25.1...v2.25.2) (2026-07-15)

### Bug Fixes

* select Darwin x64 inode ABI ([#66](https://github.com/hack-dance/fclt/issues/66)) ([d9617d2](https://github.com/hack-dance/fclt/commit/d9617d267a75f982148674f034fc887b2e6b85b3))

## [2.25.1](https://github.com/hack-dance/fclt/compare/v2.25.0...v2.25.1) (2026-07-15)

### Bug Fixes

* make fclt audit truly read-only ([#61](https://github.com/hack-dance/fclt/issues/61)) ([cceb87f](https://github.com/hack-dance/fclt/commit/cceb87f588b65bea77519835d637a14f9a4587b2))

## Unreleased

### Security

* Disable `audit fix` mutation until a durable two-file transaction and recovery protocol is available. Exact-report dry-run, read-only audit, and reviewed `audit safe` workflows remain available.

## [2.25.0](https://github.com/hack-dance/fclt/compare/v2.24.1...v2.25.0) (2026-07-14)

### Features

* **ai:** aggregate activity across scopes ([8a3753e](https://github.com/hack-dance/fclt/commit/8a3753e96fc006287c91fdc7c15e8202a9c78b53))

### Bug Fixes

* **activity:** bound global aggregate reads ([e19b657](https://github.com/hack-dance/fclt/commit/e19b65709d2a4e7d31a5c6930a54bbfacd618042))
* **activity:** distinguish configured coverage ([b839da3](https://github.com/hack-dance/fclt/commit/b839da32da12c891128c3aa5bcc343ad3a21dddb))
* **activity:** isolate and bound aggregate reads ([29d0902](https://github.com/hack-dance/fclt/commit/29d0902915964531f337acd3b7c950daf22a860c))
* **activity:** keep bounded coverage consistent ([6428aa5](https://github.com/hack-dance/fclt/commit/6428aa50c6647abe992a58c69643ab645b0578c5))
* **activity:** mark truncated feeds incomplete ([c35c15e](https://github.com/hack-dance/fclt/commit/c35c15e4e390e2f00e646afe5d1b81b57aa04ea5))
* **activity:** recompute bounded source totals ([96f014b](https://github.com/hack-dance/fclt/commit/96f014b44d957b45db4b73dd10e3bbc2b56b021a))
* **cli:** prefer the compiled package version ([3273210](https://github.com/hack-dance/fclt/commit/32732104713e5f1eb9a43409ec99280d438c84f6))
* **plugin:** pass all scope after activity ([4fcbc2a](https://github.com/hack-dance/fclt/commit/4fcbc2ae082974a74abeac94869a8f66088eb5a4))

## [2.24.1](https://github.com/hack-dance/fclt/compare/v2.24.0...v2.24.1) (2026-07-13)

### Bug Fixes

* refresh evolution loop previews ([6562492](https://github.com/hack-dance/fclt/commit/6562492a4aa717062fb4e3e0e85df08e3bcab76b))

## [2.24.0](https://github.com/hack-dance/fclt/compare/v2.23.0...v2.24.0) (2026-07-13)

### Features

* enrich activity feed context ([d37161e](https://github.com/hack-dance/fclt/commit/d37161edf0ee672e4318f737258a98fbadee5027))

### Bug Fixes

* close activity privacy and release gaps ([552a310](https://github.com/hack-dance/fclt/commit/552a310824d1e4f0af63a11d5ad053d6c2353700))
* contain private activity links ([b5d0d83](https://github.com/hack-dance/fclt/commit/b5d0d83ae31cff5f1653b43e5c2522a7ca03bc0a))
* cover standard local roots in activity URLs ([f3e29ce](https://github.com/hack-dance/fclt/commit/f3e29ced50f60e9b0a0c3a54276e0652f1d734d1))
* redact embedded absolute paths in activity URLs ([af2a314](https://github.com/hack-dance/fclt/commit/af2a31488231feb2b85965f358054b2d6b2554ee))
* redact encoded local paths in activity text ([cbf6b13](https://github.com/hack-dance/fclt/commit/cbf6b13d1dcdd23bae0d08db20dfc0a3ebbb3d08))
* redact local paths in activity text URLs ([7cc18db](https://github.com/hack-dance/fclt/commit/7cc18db706d7414a34d7c996d53abd3a7e61ad87))
* reject bare local roots in activity URLs ([3b4e0bf](https://github.com/hack-dance/fclt/commit/3b4e0bf5877438afe6c42d356cd7e1023a6366a1))
* reject embedded local paths in activity links ([a05d8fd](https://github.com/hack-dance/fclt/commit/a05d8fd2fcc64ea55842d28ddc282fcb6d43d593))
* reject encoded paths in activity links ([bad9736](https://github.com/hack-dance/fclt/commit/bad973683263ef63d05f34381d6666c5ba1b3e88))
* reject encoded target selectors ([85a08e2](https://github.com/hack-dance/fclt/commit/85a08e26f273dde5e943bdb26c8080a19be2d047))
* reject local roots in activity links ([cfe852d](https://github.com/hack-dance/fclt/commit/cfe852d95ba81463afff1045f9a95b65744665a7))
* reject target selector metadata ([1f31802](https://github.com/hack-dance/fclt/commit/1f3180227ffb7a16f898fcb9b750b67de6a4d6e3))
* strip portable URL metadata ([d5b070d](https://github.com/hack-dance/fclt/commit/d5b070df660f495687b49254e4c56a246362eb96))

## [2.23.0](https://github.com/hack-dance/fclt/compare/v2.22.3...v2.23.0) (2026-07-13)

### Features

* add privacy-safe evolution activity feed ([a8d1075](https://github.com/hack-dance/fclt/commit/a8d1075b87e6244a9a7b448a4e7d54387be5f22d))

### Bug Fixes

* close portable redaction gaps ([a975119](https://github.com/hack-dance/fclt/commit/a97511915289d325aa8cb91b378565b037e3508d))
* fully redact bearer authorization values ([06c2298](https://github.com/hack-dance/fclt/commit/06c22984ad03d39952d4e1991794ac261ea7866c))
* harden portable activity redaction ([58e9ae2](https://github.com/hack-dance/fclt/commit/58e9ae201e0d4628cd7f035222be09c2a83117f1))
* parse bounded private key blocks ([8bcbe52](https://github.com/hack-dance/fclt/commit/8bcbe528244806fca692bcb1509f33e8b0e10c74))
* redact host-qualified file URLs ([67e7f67](https://github.com/hack-dance/fclt/commit/67e7f6706b7d40471366111957ee1568ee6cc52f))
* redact partial private keys ([1d92e16](https://github.com/hack-dance/fclt/commit/1d92e167aae159d2b3124b6256a9c43b9ef194fe))

## [2.22.3](https://github.com/hack-dance/fclt/compare/v2.22.2...v2.22.3) (2026-07-12)

### Bug Fixes

* block cleanup without an owned launch plist ([5ddec8e](https://github.com/hack-dance/fclt/commit/5ddec8e0c3c258f3977d2b6081dc69c4b4950907))
* diagnose and contain legacy autosync upgrades ([18d4329](https://github.com/hack-dance/fclt/commit/18d4329440c6e2e28b8d11fd9eb5d9641e2d4a4e))
* scope launchd recovery gate to autosync state ([711e751](https://github.com/hack-dance/fclt/commit/711e751b2afe402703f814b90cab18d9537fcf52))

## [2.22.2](https://github.com/hack-dance/fclt/compare/v2.22.1...v2.22.2) (2026-07-12)

### Bug Fixes

* contain unsafe broad managed mutation ([#54](https://github.com/hack-dance/fclt/issues/54)) ([d93e443](https://github.com/hack-dance/fclt/commit/d93e4435725a24347790994061c79b2c0ae3bd03))

## [2.22.1](https://github.com/hack-dance/fclt/compare/v2.22.0...v2.22.1) (2026-07-11)

### Bug Fixes

* make Codex plugin startup desktop-safe ([#53](https://github.com/hack-dance/fclt/issues/53)) ([e937913](https://github.com/hack-dance/fclt/commit/e9379131bd7ca6ab3400eb40d95d1f73bee8980f))

## [2.22.0](https://github.com/hack-dance/fclt/compare/v2.21.0...v2.22.0) (2026-07-11)

### Features

* add scheduled evolution review loop ([#52](https://github.com/hack-dance/fclt/issues/52)) ([3010372](https://github.com/hack-dance/fclt/commit/3010372f29b5ed5d3b15164dfa5fbc60e8035ee0))

## [2.21.0](https://github.com/hack-dance/fclt/compare/v2.20.1...v2.21.0) (2026-07-11)

### Features

* add automatic source reconciliation ([#50](https://github.com/hack-dance/fclt/issues/50)) ([1a88eb0](https://github.com/hack-dance/fclt/commit/1a88eb0bad97f22c08f99f9c731c9ed041332d0e))

## [2.20.1](https://github.com/hack-dance/fclt/compare/v2.20.0...v2.20.1) (2026-07-10)

### Bug Fixes

* support Codex newline MCP framing ([344d41d](https://github.com/hack-dance/fclt/commit/344d41d961850c0300f3baba19481eb898478220))

## [2.20.0](https://github.com/hack-dance/fclt/compare/v2.19.2...v2.20.0) (2026-07-10)

### Features

* add fclt brand mark to codex plugin ([ea885ee](https://github.com/hack-dance/fclt/commit/ea885eee4a5f250508e240332050340331c4385a))
* add verified plugin runtime lifecycle ([63b1a27](https://github.com/hack-dance/fclt/commit/63b1a271f44b651466b8da07fb5f81644bf7d63d))
* enforce plugin runtime update policy ([2f4e69f](https://github.com/hack-dance/fclt/commit/2f4e69faea4ddfb7aa301d74b3ba237bdaba9554))
* expose typed safe fclt mcp routers ([d55803f](https://github.com/hack-dance/fclt/commit/d55803fedf306b0ef06f0a1fac2e4eaa27b53956))

### Bug Fixes

* discover portable Windows install state ([66b3bed](https://github.com/hack-dance/fclt/commit/66b3bed140fc0997ce3e38bf87915eb267f3869e))
* harden runtime and registry discovery ([b7c64d5](https://github.com/hack-dance/fclt/commit/b7c64d5c5d66507b00cdb35e7afa865fa039b553))
* honor active plugin runtime and mutation risk ([2732f5a](https://github.com/hack-dance/fclt/commit/2732f5a695bdb5c40219fe120b68cbd571231163))
* integrate released setup safety contract ([2bfeaa5](https://github.com/hack-dance/fclt/commit/2bfeaa5e11092f040375ab165d91675a9a7df19c))
* preserve plugin mutation and shim safety ([c9f9d39](https://github.com/hack-dance/fclt/commit/c9f9d394e296a92583239f686a811049374277c0))
* withhold unsafe plugin lifecycle mutations ([4cff43e](https://github.com/hack-dance/fclt/commit/4cff43e8b3695d3244448deee84a4f0ccef53d97))

## [2.19.2](https://github.com/hack-dance/fclt/compare/v2.19.1...v2.19.2) (2026-07-10)

### Bug Fixes

* isolate Git test harness ([#49](https://github.com/hack-dance/fclt/issues/49)) ([bafc916](https://github.com/hack-dance/fclt/commit/bafc916bd296339a84921bc9ca9eb087b99784c9))

## [2.19.1](https://github.com/hack-dance/fclt/compare/v2.19.0...v2.19.1) (2026-07-10)

### Bug Fixes

* repair dangling pack symlinks ([#47](https://github.com/hack-dance/fclt/issues/47)) ([486ea2b](https://github.com/hack-dance/fclt/commit/486ea2bd676cfee98487068fdc21512c1ca21e26))

## [2.19.0](https://github.com/hack-dance/fclt/compare/v2.18.0...v2.19.0) (2026-07-10)

### Features

* bootstrap zero-config evolution loops ([#46](https://github.com/hack-dance/fclt/issues/46)) ([9ddd512](https://github.com/hack-dance/fclt/commit/9ddd5124a33b8eba93e5053056ac2359a89f172f))

## [2.18.0](https://github.com/hack-dance/fclt/compare/v2.17.14...v2.18.0) (2026-07-10)

### Features

* **ai:** close the evolution outcome loop ([610ef3e](https://github.com/hack-dance/fclt/commit/610ef3e451bae957a00fcf134a6c917784d8ed8e))

## [2.17.14](https://github.com/hack-dance/fclt/compare/v2.17.13...v2.17.14) (2026-07-06)

### Bug Fixes

* **ai:** draft existing skill evolution targets ([128464f](https://github.com/hack-dance/fclt/commit/128464f2d256102ede146ca800a976e88abfe375))

## [2.17.13](https://github.com/hack-dance/fclt/compare/v2.17.12...v2.17.13) (2026-06-22)

### Bug Fixes

* honor explicit project ai root ([5da9a10](https://github.com/hack-dance/fclt/commit/5da9a1024f86dc091270452a1e06df003a62fe41))

## [2.17.12](https://github.com/hack-dance/fclt/compare/v2.17.11...v2.17.12) (2026-06-22)

### Bug Fixes

* avoid mise root flag conflicts ([36c74ea](https://github.com/hack-dance/fclt/commit/36c74ea65280fe1fdb5eda7b6f021c37d6f66a3a))

## [2.17.11](https://github.com/hack-dance/fclt/compare/v2.17.10...v2.17.11) (2026-06-22)

### Bug Fixes

* make doctor project actions root-aware ([5603467](https://github.com/hack-dance/fclt/commit/560346732ad2d997e86b9e77e8b28f026754a50c))

## [2.17.10](https://github.com/hack-dance/fclt/compare/v2.17.9...v2.17.10) (2026-06-22)

### Bug Fixes

* reject home for fclt MCP project cwd ([9e20d02](https://github.com/hack-dance/fclt/commit/9e20d025baac768029236e636cc4607ba446d7c6))

## [2.17.9](https://github.com/hack-dance/fclt/compare/v2.17.8...v2.17.9) (2026-06-22)

### Bug Fixes

* harden fclt MCP cwd inference ([83f7349](https://github.com/hack-dance/fclt/commit/83f7349f18db946537245a403f3c71d4cec3b591))

## [2.17.8](https://github.com/hack-dance/fclt/compare/v2.17.7...v2.17.8) (2026-06-22)

### Bug Fixes

* preserve fclt MCP workspace cwd ([3906afa](https://github.com/hack-dance/fclt/commit/3906afa7f92f6935856beee7e7648a237b769738))

## [2.17.7](https://github.com/hack-dance/fclt/compare/v2.17.6...v2.17.7) (2026-06-22)

### Bug Fixes

* launch fclt codex mcp from plugin cwd ([#39](https://github.com/hack-dance/fclt/issues/39)) ([64dd52c](https://github.com/hack-dance/fclt/commit/64dd52c735eee23ce6732cf38ed7abc0e521c2e1))

## [2.17.6](https://github.com/hack-dance/fclt/compare/v2.17.5...v2.17.6) (2026-06-20)

### Bug Fixes

* classify builtin paths portably ([832113b](https://github.com/hack-dance/fclt/commit/832113bbfebe0c724be27f288d83db4ebc0f35fd))

## [2.17.5](https://github.com/hack-dance/fclt/compare/v2.17.4...v2.17.5) (2026-06-20)

### Bug Fixes

* address review triage issues ([0a768c0](https://github.com/hack-dance/fclt/commit/0a768c024b60f07f2969e62e1595ec359f76c60b))

## [2.17.4](https://github.com/hack-dance/fclt/compare/v2.17.3...v2.17.4) (2026-06-20)

### Bug Fixes

* **ai:** skip resolved writebacks when proposing ([4aec566](https://github.com/hack-dance/fclt/commit/4aec5661195247a17ea70c23e9fa34c1e7f54b9d))

## [2.17.3](https://github.com/hack-dance/fclt/compare/v2.17.2...v2.17.3) (2026-06-20)

### Bug Fixes

* **ai:** tighten evolution assessment review flow ([970d926](https://github.com/hack-dance/fclt/commit/970d926120117722b67757b4f72f01342f84f950))

## [2.17.2](https://github.com/hack-dance/fclt/compare/v2.17.1...v2.17.2) (2026-06-20)

### Bug Fixes

* **codex:** use valid plugin auth policy ([1e7f54f](https://github.com/hack-dance/fclt/commit/1e7f54fe3e11bd4e7978c260a5241fc16da2ee5f))

## [2.17.1](https://github.com/hack-dance/fclt/compare/v2.17.0...v2.17.1) (2026-06-20)

### Bug Fixes

* **codex:** honor setup marketplace name ([b7d5b3a](https://github.com/hack-dance/fclt/commit/b7d5b3a298ad6cf2d007f9875e58ec50f2e6f13f)), closes [#31](https://github.com/hack-dance/fclt/issues/31)

## [2.17.0](https://github.com/hack-dance/fclt/compare/v2.16.0...v2.17.0) (2026-06-19)

### Features

* **codex:** add narrow plugin setup command ([2e75673](https://github.com/hack-dance/fclt/commit/2e75673a0c2d40092d64445a3a808ed78ec93516))

## [2.16.0](https://github.com/hack-dance/fclt/compare/v2.15.2...v2.16.0) (2026-06-19)

### Features

* **ai:** assess evolution readiness ([3086a03](https://github.com/hack-dance/fclt/commit/3086a03bda9f1336b7080f85ac19afd2d7ae1fd5))

## [2.15.2](https://github.com/hack-dance/fclt/compare/v2.15.1...v2.15.2) (2026-06-19)

### Bug Fixes

* **codex:** preserve live plugins during repair ([#29](https://github.com/hack-dance/fclt/issues/29)) ([b1bea0f](https://github.com/hack-dance/fclt/commit/b1bea0fe15671f3a4158c65d71cb2a39f4faf53c))

## [2.15.1](https://github.com/hack-dance/fclt/compare/v2.15.0...v2.15.1) (2026-06-19)

### Bug Fixes

* **codex:** install bundled plugin during sync ([#28](https://github.com/hack-dance/fclt/issues/28)) ([0c76f1b](https://github.com/hack-dance/fclt/commit/0c76f1ba42a2cd88ab344c24c5a180eadfcc369e))

## [2.15.0](https://github.com/hack-dance/fclt/compare/v2.14.0...v2.15.0) (2026-06-19)

### Features

* **templates:** seed operating model guidance ([#27](https://github.com/hack-dance/fclt/issues/27)) ([5a3c491](https://github.com/hack-dance/fclt/commit/5a3c491a1fc0bd15f38c569b20aef597481de8aa))

## [2.14.0](https://github.com/hack-dance/fclt/compare/v2.13.9...v2.14.0) (2026-06-19)

### Features

* **templates:** support safe operating model updates ([#26](https://github.com/hack-dance/fclt/issues/26)) ([7bbdb7b](https://github.com/hack-dance/fclt/commit/7bbdb7b78a9bb256db18cd47b29154624d7900c0))

## [2.13.9](https://github.com/hack-dance/fclt/compare/v2.13.8...v2.13.9) (2026-06-19)

### Bug Fixes

* harden binary guidance verifier ([39dc3a9](https://github.com/hack-dance/fclt/commit/39dc3a96b07b8af647670a893e91e68fc82f4099))

## [2.13.8](https://github.com/hack-dance/fclt/compare/v2.13.7...v2.13.8) (2026-06-19)

### Bug Fixes

* relax binary guidance verifier paths ([bc74150](https://github.com/hack-dance/fclt/commit/bc74150fa0357b00c1e0b814a2c538b7ffa255a4))

## [2.13.7](https://github.com/hack-dance/fclt/compare/v2.13.6...v2.13.7) (2026-06-19)

### Bug Fixes

* remove private defaults from builtin guidance ([076c8a0](https://github.com/hack-dance/fclt/commit/076c8a0a2bfb035335b33a8f11fecdaa17a29915))

## [2.13.6](https://github.com/hack-dance/fclt/compare/v2.13.5...v2.13.6) (2026-06-19)

### Bug Fixes

* preserve global agents template semantics ([abbcf02](https://github.com/hack-dance/fclt/commit/abbcf021b08e488d4c546d37b603fb4c1603a126))

## [2.13.5](https://github.com/hack-dance/fclt/compare/v2.13.4...v2.13.5) (2026-06-19)

### Bug Fixes

* persist mise self-update state ([ccc643b](https://github.com/hack-dance/fclt/commit/ccc643bc23d5bdbc3f0a72b29d86c439ff87de0b))

## [2.13.4](https://github.com/hack-dance/fclt/compare/v2.13.3...v2.13.4) (2026-06-19)

### Bug Fixes

* detect mise-managed self updates ([#18](https://github.com/hack-dance/fclt/issues/18)) ([40c99ce](https://github.com/hack-dance/fclt/commit/40c99ce4f8ba32edb38bbe6661d699aa514aa134))

## [2.13.3](https://github.com/hack-dance/fclt/compare/v2.13.2...v2.13.3) (2026-06-19)

### Bug Fixes

* update mise-managed installs ([#17](https://github.com/hack-dance/fclt/issues/17)) ([7d6530a](https://github.com/hack-dance/fclt/commit/7d6530a561cf5f67c02477d4acd87d0e209408b6))

## [2.13.2](https://github.com/hack-dance/fclt/compare/v2.13.1...v2.13.2) (2026-06-19)

### Bug Fixes

* self-heal broken global guidance ([9db510e](https://github.com/hack-dance/fclt/commit/9db510e585a5f32d22595e39c1fd13654b8c7b0d))

## [2.13.1](https://github.com/hack-dance/fclt/compare/v2.13.0...v2.13.1) (2026-06-19)

### Bug Fixes

* **launcher:** tolerate concurrent runtime installs ([d1724d4](https://github.com/hack-dance/fclt/commit/d1724d4a0a01ec77f32cb27c8deec1154308ef68))

## [2.13.0](https://github.com/hack-dance/fclt/compare/v2.12.0...v2.13.0) (2026-06-19)

### Features

* **setup:** add read-only health APIs ([4f4cc45](https://github.com/hack-dance/fclt/commit/4f4cc45a6c8826c01c977e816996065eb9599ebe))

## [2.12.0](https://github.com/hack-dance/fclt/compare/v2.11.0...v2.12.0) (2026-06-19)

### Features

* **templates:** scaffold instruction assets ([3291605](https://github.com/hack-dance/fclt/commit/3291605603ce6f2e152caad907543d01928ba44f))

## [2.11.0](https://github.com/hack-dance/fclt/compare/v2.10.0...v2.11.0) (2026-06-19)

### Features

* **templates:** install operating model pack independently ([f451360](https://github.com/hack-dance/fclt/commit/f45136096c25551a2520cb8cdc90e29d6a06d7e8))

## [2.10.0](https://github.com/hack-dance/fclt/compare/v2.9.0...v2.10.0) (2026-06-19)

### Features

* **manage:** make live adoption opt-in ([e0efcd4](https://github.com/hack-dance/fclt/commit/e0efcd4092077817ea9828aee04c9a9b20b2a734))

## [2.9.0](https://github.com/hack-dance/fclt/compare/v2.8.12...v2.9.0) (2026-06-19)

### Features

* **ai:** mirror review artifacts into global ai root ([d3ae725](https://github.com/hack-dance/fclt/commit/d3ae72511f0c05cb454c31e43a355c218d857715))

## [2.8.12](https://github.com/hack-dance/fclt/compare/v2.8.11...v2.8.12) (2026-06-19)

### Bug Fixes

* **index:** clean builtin canonical refs ([7873462](https://github.com/hack-dance/fclt/commit/78734625d221789317ca03ef071a2c8579a6194a))

## [2.8.11](https://github.com/hack-dance/fclt/compare/v2.8.10...v2.8.11) (2026-06-19)

### Bug Fixes

* **ci:** isolate windows binary verification home ([f6c40b1](https://github.com/hack-dance/fclt/commit/f6c40b17ab0be2b67c7ba43b499cecd74a38b07a))

## [2.8.10](https://github.com/hack-dance/fclt/compare/v2.8.9...v2.8.10) (2026-06-19)

### Bug Fixes

* **pkg:** embed builtin defaults in binary ([59e9365](https://github.com/hack-dance/fclt/commit/59e9365d9442bf1724868196bcb5f35bc50d9fc5))

## [2.8.9](https://github.com/hack-dance/fclt/compare/v2.8.8...v2.8.9) (2026-06-19)

### Bug Fixes

* **pkg:** publish feedback loop defaults ([44bb9d0](https://github.com/hack-dance/fclt/commit/44bb9d0bff9200b6fb3b99d5076420ae4f2ed686))

## [2.8.8](https://github.com/hack-dance/fclt/compare/v2.8.7...v2.8.8) (2026-06-19)

### Bug Fixes

* **cli:** avoid runtime download temp races ([be7ee44](https://github.com/hack-dance/fclt/commit/be7ee44108e06351b514b307395cbd86b7024cb3))

## [2.8.7](https://github.com/hack-dance/fclt/compare/v2.8.6...v2.8.7) (2026-06-19)

### Bug Fixes

* **cli:** use temp runtime cache fallback ([de6ab43](https://github.com/hack-dance/fclt/commit/de6ab436cf08d9e57db554d98b4ad7fe784813bc))

## [2.8.6](https://github.com/hack-dance/fclt/compare/v2.8.5...v2.8.6) (2026-06-19)

### Bug Fixes

* **ai:** store evolution runtime in machine-local state ([9908344](https://github.com/hack-dance/fclt/commit/99083449b4bddb0ab9558c4e8baadb2ac3886b0b))

## [2.8.5](https://github.com/hack-dance/fclt/compare/v2.8.4...v2.8.5) (2026-05-29)

### Bug Fixes

* guard legacy index metadata by source ([a53fb8f](https://github.com/hack-dance/fclt/commit/a53fb8f6c3d9d0130716c5b161e0bf60fae920d5))

## [2.8.4](https://github.com/hack-dance/fclt/compare/v2.8.3...v2.8.4) (2026-05-29)

### Bug Fixes

* preserve legacy ai index metadata ([c75a56e](https://github.com/hack-dance/fclt/commit/c75a56e966a23e924dc38fef65aa7b4bd1b9a169))

## [2.8.3](https://github.com/hack-dance/fclt/compare/v2.8.2...v2.8.3) (2026-05-29)

### Bug Fixes

* preserve legacy project ai migration state ([50811a8](https://github.com/hack-dance/fclt/commit/50811a899083f021d80e316b0c7d9f18d840b522)), closes [#12](https://github.com/hack-dance/fclt/issues/12)

## [2.8.2](https://github.com/hack-dance/fclt/compare/v2.8.1...v2.8.2) (2026-05-29)

### Bug Fixes

* keep project ai state machine-local ([7b92d74](https://github.com/hack-dance/fclt/commit/7b92d74dd1d75e140b2a1367cbfb63cf1a6c3988))

## [2.8.1](https://github.com/hack-dance/fclt/compare/v2.8.0...v2.8.1) (2026-05-24)

### Bug Fixes

* embed version in compiled status ([f2a1276](https://github.com/hack-dance/fclt/commit/f2a127692fbcf9c574bf2205a90227709795284a))

## [2.8.0](https://github.com/hack-dance/fclt/compare/v2.7.7...v2.8.0) (2026-05-24)

### Features

* harden agent inventory surfaces ([666a876](https://github.com/hack-dance/fclt/commit/666a876c4634a11ba4ca422f406ae34570656bf5))

## [2.7.7](https://github.com/hack-dance/fclt/compare/v2.7.6...v2.7.7) (2026-05-24)

### Bug Fixes

* align managed adoption with project sync policy ([0600604](https://github.com/hack-dance/fclt/commit/060060407394d9fd33462eda77f456504caad863))

## [2.7.6](https://github.com/hack-dance/fclt/compare/v2.7.5...v2.7.6) (2026-05-24)

### Bug Fixes

* require project automation sync opt-in ([1c21721](https://github.com/hack-dance/fclt/commit/1c21721bd57f74d9bb542faedf93658d14947174))

## [2.7.5](https://github.com/hack-dance/fclt/compare/v2.7.4...v2.7.5) (2026-05-24)

### Bug Fixes

* protect managed sync from destructive drift ([0ed2fda](https://github.com/hack-dance/fclt/commit/0ed2fdaea9d86bd99fb37f97dd6d00036422af2c))

## [2.7.4](https://github.com/hack-dance/fclt/compare/v2.7.3...v2.7.4) (2026-05-01)

### Bug Fixes

* **project-ai:** detect lightweight repo AI roots ([a1fdd9e](https://github.com/hack-dance/fclt/commit/a1fdd9e3ec1a4b369d135099562428f54311ae30))

## [2.7.3](https://github.com/hack-dance/fclt/compare/v2.7.2...v2.7.3) (2026-04-16)

### Bug Fixes

* **graph:** index automations in AI graph ([d42563b](https://github.com/hack-dance/fclt/commit/d42563b3c29f5e77f5558da989433dca77c59bf8))

## [2.7.2](https://github.com/hack-dance/fclt/compare/v2.7.1...v2.7.2) (2026-04-15)

### Bug Fixes

* accept missing canonical refs in index carry-forward ([188482b](https://github.com/hack-dance/fclt/commit/188482baf548b279a720a89ec57e59f534d89bea))
* harden stale ai state rebuilds ([7425e87](https://github.com/hack-dance/fclt/commit/7425e87d853013892c780aaa2d83588f8046b2d5))
* keep agent metadata scoped to canonical refs ([7979fcc](https://github.com/hack-dance/fclt/commit/7979fcc9cfd0b84635a7acaa167aaef7395d51ce))
* preserve ai metadata on stale rebuild ([e419942](https://github.com/hack-dance/fclt/commit/e4199424599c9e11f163379a433edae02c8d0fec))
* preserve mcp metadata per server ([0f2b356](https://github.com/hack-dance/fclt/commit/0f2b3567e39a7fb06b4f39b630fa15dba4044c95))
* rebuild stale generated ai indexes ([f6ba099](https://github.com/hack-dance/fclt/commit/f6ba099a2389fb54ae6e76ee7de62c1846a12387))
* watch global ai inputs for project rebuilds ([2d9a435](https://github.com/hack-dance/fclt/commit/2d9a435f880ee6068592fb288d18f4af4e934f6b))
* watch graph config and tool inputs ([d8169b2](https://github.com/hack-dance/fclt/commit/d8169b24d02c447cc76badf79003535e754e8785))

## [2.7.1](https://github.com/hack-dance/fclt/compare/v2.7.0...v2.7.1) (2026-03-30)

### Bug Fixes

* tighten project sync and codex plugin migration safety ([f897373](https://github.com/hack-dance/fclt/commit/f897373570bccd6801b92030c4009ba0ad6b8279))

### Performance Improvements

* lazy load CLI command modules ([c05b185](https://github.com/hack-dance/fclt/commit/c05b18581c62bc39f66dc9fae71873fcb624bcf3))

## [2.7.0](https://github.com/hack-dance/fclt/compare/v2.6.0...v2.7.0) (2026-03-26)

### Features

* **cli:** improve audit ux and mcp secret remediation ([2b69a25](https://github.com/hack-dance/fclt/commit/2b69a2529858c62acb384f5933f3ba896d7c12ef))
* **trust:** add bulk trust and untrust commands ([38c6a7d](https://github.com/hack-dance/fclt/commit/38c6a7d0b772b6564c151fc70a3242ff8d946277))

## [2.6.0](https://github.com/hack-dance/fclt/compare/v2.5.2...v2.6.0) (2026-03-26)

### Features

* support tool-local config overlays ([2a0865f](https://github.com/hack-dance/fclt/commit/2a0865f97a496a1e9436f40fbe940fc283af7a38))

## [2.5.2](https://github.com/hack-dance/fclt/compare/v2.5.1...v2.5.2) (2026-03-25)

### Bug Fixes

* treat automation memory as runtime state ([a96c1c7](https://github.com/hack-dance/fclt/commit/a96c1c7f3aa670e4769bc796a0017d9afbab44af))

## [2.5.1](https://github.com/hack-dance/fclt/compare/v2.5.0...v2.5.1) (2026-03-25)

### Bug Fixes

* bootstrap project ai before learning writebacks ([52476bb](https://github.com/hack-dance/fclt/commit/52476bbfbe9f2ea92a7c3814b9200c4c322c860d))

## [2.5.0](https://github.com/hack-dance/fclt/compare/v2.4.0...v2.5.0) (2026-03-24)

### Features

* **factory:** add managed factory tool support ([74393a2](https://github.com/hack-dance/fclt/commit/74393a2da127a4b004bdf5b73aea48744606a705))

### Bug Fixes

* resolve factory CI lint failures ([c459f98](https://github.com/hack-dance/fclt/commit/c459f98a6a4860ffef473c9aaaed019bb0c9df7f))

## [2.4.0](https://github.com/hack-dance/fclt/compare/v2.3.1...v2.4.0) (2026-03-24)

### Features

* centralize codex automations and localize machine state ([a34c9be](https://github.com/hack-dance/fclt/commit/a34c9be5df24a73d65d0f9b87b9d58846a00e674))

### Bug Fixes

* make machine-state path tests cross-platform ([ec8dfa0](https://github.com/hack-dance/fclt/commit/ec8dfa06377b36dc544650a450e2d021c2d43700))
* return promised launchctl test results ([9fce337](https://github.com/hack-dance/fclt/commit/9fce3372c4095bdb2fb2eaef20329496a85658b6))

## [2.3.1](https://github.com/hack-dance/fclt/compare/v2.3.0...v2.3.1) (2026-03-24)

### Bug Fixes

* avoid install-state writes on cached launcher runs ([3670823](https://github.com/hack-dance/fclt/commit/3670823ab4ca3bfe712a0d83cfeb00ce77cbbd04))

## [2.3.0](https://github.com/hack-dance/fclt/compare/v2.2.0...v2.3.0) (2026-03-20)

### Features

* add evolution review automation template ([3b633fd](https://github.com/hack-dance/fclt/commit/3b633fd62c63b97ff32c38c6ef2f537a12721039))

### Bug Fixes

* harden writeback capture and cli fallback ([afebfec](https://github.com/hack-dance/fclt/commit/afebfec0dfcdcb262ac0464710bef1fdba20982f))

## [2.2.0](https://github.com/hack-dance/fclt/compare/v2.1.2...v2.2.0) (2026-03-20)

### Features

* improve codex automation templates ([6136c82](https://github.com/hack-dance/fclt/commit/6136c8281653be038c3f3a976f92c14ac6e15708))

## [2.1.2](https://github.com/hack-dance/fclt/compare/v2.1.1...v2.1.2) (2026-03-19)

### Bug Fixes

* tighten default writeback and evolution guidance ([0948241](https://github.com/hack-dance/fclt/commit/09482412e4434526f4b288ca1d0fcd20f882297b))

## [2.1.1](https://github.com/hack-dance/fclt/compare/v2.1.0...v2.1.1) (2026-03-19)

### Bug Fixes

* update fclt repo links and badges ([6bce29b](https://github.com/hack-dance/fclt/commit/6bce29b604e7faf4ef621fef43353a1b49fc3c2f))

## [2.1.0](https://github.com/hack-dance/facult/compare/v2.0.1...v2.1.0) (2026-03-19)

### Features

* add homebrew tap publishing for fclt ([b337001](https://github.com/hack-dance/facult/commit/b3370017bc744a8ebd4966479771bd71aee0e12c))

## [2.0.1](https://github.com/hack-dance/facult/compare/v2.0.0...v2.0.1) (2026-03-19)

### Bug Fixes

* keep facult as the npm package for fclt ([2546c66](https://github.com/hack-dance/facult/commit/2546c665f39d32bbe34374b30a49ab5ae0966820))

## [2.0.0](https://github.com/hack-dance/facult/compare/v1.3.0...v2.0.0) (2026-03-19)

### ⚠ BREAKING CHANGES

* rename npm package and primary cli to fclt

### Features

* rename npm package and primary cli to fclt ([0ab363c](https://github.com/hack-dance/facult/commit/0ab363c662e560d9a4f46906498c943d124ceea0))

## [1.3.0](https://github.com/hack-dance/facult/compare/v1.2.1...v1.3.0) (2026-03-19)

### Features

* move facult state under canonical ai roots ([bdf0df4](https://github.com/hack-dance/facult/commit/bdf0df4ec9a1819b8ac092e99d496de3090049dc))

## [1.2.1](https://github.com/hack-dance/facult/compare/v1.2.0...v1.2.1) (2026-03-19)

### Bug Fixes

* preserve codex system skills during sync ([2a8bd85](https://github.com/hack-dance/facult/commit/2a8bd85aa8c3e89f62400dd64c7edf5be61e31cc))

## [1.2.0](https://github.com/hack-dance/facult/compare/v1.1.0...v1.2.0) (2026-03-19)

### Features

* add scoped ai capability management and evolution ([31093ec](https://github.com/hack-dance/facult/commit/31093ec141450006925f996cb332d8d39d77e438))

## [1.1.0](https://github.com/hack-dance/facult/compare/v1.0.3...v1.1.0) (2026-03-18)

### Features

* add ai sync and autosync management ([0748679](https://github.com/hack-dance/facult/commit/0748679a4edab1c2685ac97ebc5f36c3b268a15a))

## [1.0.3](https://github.com/hack-dance/facult/compare/v1.0.2...v1.0.3) (2026-02-21)

### Bug Fixes

* **release:** publish public-only installer changes ([7683690](https://github.com/hack-dance/facult/commit/7683690a207e7bca0dd78d87a48ae32678901adf))

## [1.0.2](https://github.com/hack-dance/facult/compare/v1.0.1...v1.0.2) (2026-02-21)

### Bug Fixes

* **install:** support bash 3 with empty auth token ([bfa5221](https://github.com/hack-dance/facult/commit/bfa5221bb77c022361b47d464cc88a59a203f5d5))

## [1.0.1](https://github.com/hack-dance/facult/compare/v1.0.0...v1.0.1) (2026-02-21)

### Bug Fixes

* **release:** enable npm provenance publish ([7d31397](https://github.com/hack-dance/facult/commit/7d31397733149fe4f07d824e78c1a08afed28ac8))

## 1.0.0 (2026-02-21)

### Features

* **hardening:** expand consolidation coverage and verify remote manifest integrity ([bcc24c0](https://github.com/hack-dance/facult/commit/bcc24c0eacc805319aa8f25f4fe3f3ea2ae6f819))
* improve consolidate auto mode and simplify docs ([f92ddbf](https://github.com/hack-dance/facult/commit/f92ddbf9fef0b2f61ea59a77ed8765149f9ef28d))
* **release:** add binary assets workflow and self-update ([797593c](https://github.com/hack-dance/facult/commit/797593cbf348a7c7b130f365f29fe780b09319a9))
* **remote:** add ed25519 signature verification for manifest sources ([afe586d](https://github.com/hack-dance/facult/commit/afe586d379be901837ee4b57a84894b5ed443a3e))
* **remote:** add source trust policy module + strict source gating ([a5c4dd3](https://github.com/hack-dance/facult/commit/a5c4dd3d4c879c0804e8397d0318923011db8ee1))

### Bug Fixes

* **release:** add conventional commits preset dependency ([1d6f592](https://github.com/hack-dance/facult/commit/1d6f59283970e09b57f5fd9a9dc23ed32cd3a35b))
* **release:** gate npm publish behind asset release workflow ([0cc34aa](https://github.com/hack-dance/facult/commit/0cc34aa2cdc37792f75fbbd4bd925ec96238a0cd))
* **release:** support authenticated release asset downloads ([54a9ec3](https://github.com/hack-dance/facult/commit/54a9ec3c221e51b8df5bbabd7a83ad285cdc7d54))
* **release:** use supported intel macOS runner label ([3addee9](https://github.com/hack-dance/facult/commit/3addee92071069cce8d9e2842551d24f0cee295e))

## 1.0.0 (2026-02-21)

### Features

* **hardening:** expand consolidation coverage and verify remote manifest integrity ([bcc24c0](https://github.com/hack-dance/facult/commit/bcc24c0eacc805319aa8f25f4fe3f3ea2ae6f819))
* improve consolidate auto mode and simplify docs ([f92ddbf](https://github.com/hack-dance/facult/commit/f92ddbf9fef0b2f61ea59a77ed8765149f9ef28d))
* **release:** add binary assets workflow and self-update ([797593c](https://github.com/hack-dance/facult/commit/797593cbf348a7c7b130f365f29fe780b09319a9))
* **remote:** add ed25519 signature verification for manifest sources ([afe586d](https://github.com/hack-dance/facult/commit/afe586d379be901837ee4b57a84894b5ed443a3e))
* **remote:** add source trust policy module + strict source gating ([a5c4dd3](https://github.com/hack-dance/facult/commit/a5c4dd3d4c879c0804e8397d0318923011db8ee1))

### Bug Fixes

* **release:** add conventional commits preset dependency ([1d6f592](https://github.com/hack-dance/facult/commit/1d6f59283970e09b57f5fd9a9dc23ed32cd3a35b))
* **release:** gate npm publish behind asset release workflow ([0cc34aa](https://github.com/hack-dance/facult/commit/0cc34aa2cdc37792f75fbbd4bd925ec96238a0cd))
* **release:** use supported intel macOS runner label ([3addee9](https://github.com/hack-dance/facult/commit/3addee92071069cce8d9e2842551d24f0cee295e))

## 1.0.0 (2026-02-21)

### Features

* **hardening:** expand consolidation coverage and verify remote manifest integrity ([bcc24c0](https://github.com/hack-dance/facult/commit/bcc24c0eacc805319aa8f25f4fe3f3ea2ae6f819))
* improve consolidate auto mode and simplify docs ([f92ddbf](https://github.com/hack-dance/facult/commit/f92ddbf9fef0b2f61ea59a77ed8765149f9ef28d))
* **release:** add binary assets workflow and self-update ([797593c](https://github.com/hack-dance/facult/commit/797593cbf348a7c7b130f365f29fe780b09319a9))
* **remote:** add ed25519 signature verification for manifest sources ([afe586d](https://github.com/hack-dance/facult/commit/afe586d379be901837ee4b57a84894b5ed443a3e))
* **remote:** add source trust policy module + strict source gating ([a5c4dd3](https://github.com/hack-dance/facult/commit/a5c4dd3d4c879c0804e8397d0318923011db8ee1))

### Bug Fixes

* **release:** add conventional commits preset dependency ([1d6f592](https://github.com/hack-dance/facult/commit/1d6f59283970e09b57f5fd9a9dc23ed32cd3a35b))
* **release:** gate npm publish behind asset release workflow ([0cc34aa](https://github.com/hack-dance/facult/commit/0cc34aa2cdc37792f75fbbd4bd925ec96238a0cd))

## 1.0.0 (2026-02-21)

### Features

* **hardening:** expand consolidation coverage and verify remote manifest integrity ([bcc24c0](https://github.com/hack-dance/facult/commit/bcc24c0eacc805319aa8f25f4fe3f3ea2ae6f819))
* improve consolidate auto mode and simplify docs ([f92ddbf](https://github.com/hack-dance/facult/commit/f92ddbf9fef0b2f61ea59a77ed8765149f9ef28d))
* **release:** add binary assets workflow and self-update ([797593c](https://github.com/hack-dance/facult/commit/797593cbf348a7c7b130f365f29fe780b09319a9))
* **remote:** add ed25519 signature verification for manifest sources ([afe586d](https://github.com/hack-dance/facult/commit/afe586d379be901837ee4b57a84894b5ed443a3e))
* **remote:** add source trust policy module + strict source gating ([a5c4dd3](https://github.com/hack-dance/facult/commit/a5c4dd3d4c879c0804e8397d0318923011db8ee1))

### Bug Fixes

* **release:** add conventional commits preset dependency ([1d6f592](https://github.com/hack-dance/facult/commit/1d6f59283970e09b57f5fd9a9dc23ed32cd3a35b))
* **release:** gate npm publish behind asset release workflow ([0cc34aa](https://github.com/hack-dance/facult/commit/0cc34aa2cdc37792f75fbbd4bd925ec96238a0cd))

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
