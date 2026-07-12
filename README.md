# Ostracon OB

Obsidian侧插件，负责在本地启动WebSocket服务、接收来自MarginNote的知识包，并将内容落到Vault中。

## 功能

- 监听`127.0.0.1`上的本地WebSocket连接
- 首次连接由Obsidian确认设备，后续通过clientId识别
- 接收`hello`、`ping`、`sync_request`、`event`、`command`类消息
- 将知识包写入Vault下的可配置目录
- 在插件内提供收件箱视图，查看已接收包和落盘路径

## 安装

1. 在本仓库执行`npm run build`
2. 将整个`ostracon-ob`目录复制到目标Vault的`.obsidian/plugins/ostracon-ob/`
3. 确认目录中存在`manifest.json`、`main.js`、`styles.css`
4. 在Obsidian插件列表中启用`Ostracon OB`

## 开发

- `npm run build`：生成Obsidian可加载的`main.js`
- `npm run dev`：监听源码变更并重新打包

## 安全与数据边界

- 仅监听本机`127.0.0.1`
- 首次连接必须由Obsidian用户确认
- 插件会把接收到的知识包写入当前Vault
- 插件不会主动连接外部网络，所有通信都发生在本机

## 目录约定

- `src/`：插件源码
- `main.js`：构建产物
- `styles.css`：插件样式
- `manifest.json`：Obsidian插件清单
