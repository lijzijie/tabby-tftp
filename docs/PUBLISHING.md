# 发布到开源社区

这个插件通过 npm 包被 Tabby 插件管理器发现。包名保持 `tabby-tftp`（`tabby-` 前缀），并保留 `tabby-plugin` 关键词即可参与搜索。

## 首次发布

1. 在 GitHub 创建公开仓库，例如 `tabby-tftp`，再把仓库地址填入 `package.json` 的 `repository`、`homepage` 和 `bugs` 字段。
2. 检查 `package.json` 的版本号。npm 不允许重复发布同一个版本。
3. 在项目根目录执行：

   ```powershell
   npm login
   npm run verify
   npm publish --access public
   ```

4. 用 `npm view tabby-tftp` 检查包的版本、关键词和 README 是否正确。
5. 创建对应的 Git tag 和 GitHub Release，并把安装方式写入 Release 说明。

## 后续版本

每次发布前先修改 `package.json` 版本号（推荐遵循语义化版本），更新 `CHANGELOG.md`，再运行 `npm run verify` 和 `npm publish`。发布前请确认包内没有调试构建、个人路径、访问令牌或固件文件：

```powershell
npm pack --dry-run
```

## Tabby 集成说明

Tabby 的插件管理器按 `tabby-` 包名前缀和 `tabby-plugin` 关键词检索 npm。发布后如果搜索结果尚未更新，等待 npm registry 缓存刷新后再在 Tabby 中重试。

这个项目不修改 Tabby 核心代码，也不捆绑 Angular、RxJS 或 `tabby-core`；这些依赖通过 peer dependencies 使用 Tabby 自己提供的版本。
