# Tabby TFTP

`tabby-tftp` 为 [Tabby](https://github.com/Eugeny/tabby) 提供适合固件下载的 TFTP 工具：

- TFTP 文件上传和下载客户端。
- 本地只读 TFTP 服务端，适合串口 Bootloader 烧录固件。
- 支持 `blksize`、`timeout`、`tsize` 选项协商。
- 显示传输进度、速度、重试/取消状态、服务端日志和本机 IPv4 地址。
- 关闭并重新打开管理窗口后，服务端状态和配置仍然保留。

> TFTP 没有身份认证和加密功能，只应在可信、隔离的局域网中使用。

## 串口烧录流程

1. 从 Tabby 工具栏打开 **TFTP 文件传输**。
2. 选择 **固件 TFTP 服务端**，选择固件根目录并启动服务端。
3. 记下插件显示的设备可访问本机 IPv4 地址。
4. 在串口 Bootloader 中配置服务端地址并请求固件。U-Boot 常见命令包括 `serverip`、`ipaddr` 和 `tftpboot`。
5. 关闭窗口不会停止服务端；只有手动停止、启用的自动停止计时器到期或退出 Tabby 才会停止。

服务端是只读的：设备可以下载根目录中的文件，但不能向电脑上传或覆盖文件。

## 本地构建与测试

需要 Node.js 18 或更高版本。

```powershell
npm ci
npm run verify
npm run pack:plugin
```

`npm run verify` 会执行类型检查、协议/服务端测试和生产构建。

## 本地安装

关闭 Tabby，在 Tabby 用户插件目录中安装生成的 `.tgz` 包，然后重新启动 Tabby：

```powershell
cd "$env:APPDATA\tabby\plugins"
npm install C:\path\to\tabby-tftp-0.2.1.tgz --legacy-peer-deps
```

## 参与贡献与发布

参见 [CONTRIBUTING.md](CONTRIBUTING.md)、[CHANGELOG.md](CHANGELOG.md) 和 [docs/PUBLISHING.md](docs/PUBLISHING.md)。

## 许可证

MIT，详见 [LICENSE](LICENSE)。
