# Ostracon OB

Ostracon OB connects Obsidian with MarginNote. It lets you import MarginNote cards into your vault, send Obsidian notes to MarginNote, and export rendered vault documents to MarginNote as PDFs.

Ostracon OB连接Obsidian与MarginNote，可将MarginNote卡片导入Obsidian、将Obsidian笔记发送到MarginNote，并将渲染后的Vault文档以PDF形式导入MarginNote。

## 功能

- 在Obsidian侧接收MarginNote发送的Markdown、HTML卡片和Canvas内容
- 在右侧面板浏览、筛选并导入MarginNote卡片
- 将Obsidian文档渲染为PDF并导入当前MarginNote学习集
- 配置PDF纸张、方向、页边距、缩放、背景、媒体高度和页眉页脚
- 通过本地WebSocket连接MarginNote，并在首次连接时确认设备

## 系统要求

- Obsidian桌面版`1.5.0`或更高版本
- macOS版MarginNote及配套的[Ostracon MN插件](https://github.com/Temsys-Shen/ostracon-mn)

本插件依赖Obsidian桌面版提供的Electron和Node.js能力，不支持Obsidian移动版。

## 安装

### Obsidian社区插件商店

插件通过审核后，可在Obsidian的“第三方插件市场”中搜索`Ostracon OB`并安装。

### 手动安装

1. 从[GitHub Releases](https://github.com/Temsys-Shen/ostracon-ob/releases)下载同一版本的`manifest.json`、`main.js`和`styles.css`
2. 在Vault的`.obsidian/plugins/`目录下创建`ostracon-ob`文件夹
3. 将三个文件放入`.obsidian/plugins/ostracon-ob/`
4. 重新加载Obsidian，并在“第三方插件”中启用`Ostracon OB`

## 使用

1. 在Obsidian中启用Ostracon OB
2. 在MarginNote中安装并打开Ostracon MN插件
3. 通过Ostracon MN连接Obsidian，并在Obsidian中批准首次连接
4. 使用Obsidian右侧面板导入MN卡片，或在MarginNote中浏览并导入Obsidian文档

PDF打印样式可在“设置→Ostracon OB→文档导出”中调整。

## 隐私与数据边界

- OB和MN插件通过本机或局域网WebSocket通信，不使用Ostracon云服务
- 首次连接需要Obsidian用户明确批准
- 插件仅在用户执行发送、导入或导出操作时读写对应内容
- 局域网连接范围取决于设置中配置的监听地址和端口

## 开发

```bash
npm install
npm run test
npm run build
```

生产构建会生成Obsidian加载所需的`main.js`，并将`manifest.json`、`main.js`和`styles.css`打包到`dist/`。

## License

[MIT](LICENSE)
