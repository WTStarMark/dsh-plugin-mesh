# dsh-plugin-verifier

DSH 插件安装前验证器（V0~V2），只读 npm/tarball/patch，不安装 DSH、不执行插件代码。

```bash
npm install --prefix tools/plugin-verifier
npm --prefix tools/plugin-verifier test
node tools/plugin-verifier/cli.mjs --package-dir tools/plugin-verifier/fixtures/good
node tools/plugin-verifier/cli.mjs --package dsh-whale-widget --graph data/mesh.json
```

设计说明见 [docs/plugin-verification.md](../../docs/plugin-verification.md)。
