# ChatGPT Web Bridge - 开发环境配置

## 1. 前置要求

| 工具 | 版本要求 | 用途 |
|------|---------|------|
| Node.js | >= 18.x | VS Code 扩展编译 |
| npm | >= 9.x | 依赖管理 |
| VS Code | >= 1.92.0 | 扩展宿主 |
| Chrome | >= 120 (MV3) | 浏览器扩展 |

```bash
# 验证版本
node -v   # 应 >= v18
npm -v    # 应 >= 9
```

---

## 2. VS Code 扩展开发

### 2.1 安装依赖 & 编译

```bash
cd src/vscode_extension
npm install
npm run compile   # 或 npx tsc -p .
```

编译产物在 `out/` 目录。

### 2.2 调试运行

1. 用 VS Code 打开 `src/vscode_extension/` 目录
2. 按 **F5** 启动「Extension Development Host」
3. 在新窗口的命令面板（`Cmd+Shift+P` / `Ctrl+Shift+P`）中运行：
   - `ChatGPT Bridge: Start Local Bridge Server`
   - `ChatGPT Bridge: Open Bridge Panel`

### 2.3 持续编译（开发时推荐）

```bash
npm run watch   # 等同于 tsc -watch -p .
```

---

## 3. Chrome 扩展加载

### 3.1 加载未打包扩展

1. 打开 Chrome，进入 `chrome://extensions/`
2. 开启右上角 **开发者模式**
3. 点击 **加载已解压的扩展程序**
4. 选择 `src/chrome_extension/` 目录
5. 扩展会出现在列表中，点击"详情"可查看 ID

### 3.2 刷新扩展（改动后）

- 改动 `content.js` / `background.js` / `offscreen.js` 后：
  - 回到 `chrome://extensions/`，点击扩展卡片上的 **刷新** 按钮
  - **重新加载** ChatGPT 页面（`Cmd+R` / `Ctrl+R`）

- 改动 `manifest.json` 后：
  - 需要点击扩展卡片上的 **刷新** 按钮

### 3.3 调试

- **background（Service Worker）**: 在扩展卡片上点击「Service Worker」链接，打开 DevTools
- **content script**: 在 ChatGPT 页面按 F12 打开 DevTools，切到 Sources → Content scripts
- **offscreen**: 在 `chrome://extensions/` 点击「inspect offscreen」（如果有）

---

## 4. 端到端测试流程

### 4.1 启动 VS Code 扩展

```
命令面板 → ChatGPT Bridge: Start Local Bridge Server
```

默认监听 `127.0.0.1:17321`

### 4.2 连接 Chrome 扩展

1. 打开 ChatGPT 网页（`chatgpt.com`）
2. 点击扩展 Popup
3. 点击 **Connect**
4. 状态应显示 `Connected`

### 4.3 测试自动上传功能（新功能）

```
命令面板 → ChatGPT Bridge: Send Files to Chrome (Auto Upload)
```

1. 选择 1~N 个文件（每个 < 10MB）
2. 观察 ChatGPT 页面是否弹出上传对话框并显示附件
3. 如果失败，查看：
   - VS Code 输出面板（或 Bridge Panel messages）
   - ChatGPT 页面 DevTools Console 的 content script 报错
   - Chrome 扩展 Service Worker DevTools Console

---

## 5. 目录结构概览

```
src/
├── chrome_extension/
│   ├── manifest.json      # MV3 manifest
│   ├── background.js      # Service Worker
│   ├── content.js         # 注入 ChatGPT 页面
│   ├── offscreen.html/js  # 保持 WebSocket 连接
│   ├── popup.html/js/css  # 扩展弹窗 UI
│   └── ...
└── vscode_extension/
    ├── package.json       # 扩展配置 & 命令定义
    ├── tsconfig.json
    ├── src/
    │   ├── extension.ts   # 入口 & 命令实现
    │   ├── bridgeServer.ts# WebSocket 服务
    │   ├── types.ts       # 协议类型定义
    │   └── ...
    ├── media/             # Webview 资源
    └── out/               # 编译产物
```

---

## 6. 常见问题

### Q: `tsc` / `npm` 命令找不到

A: 确保 Node.js 已安装并在 PATH 中。可用 `nvm` 管理版本：

```bash
# macOS / Linux
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
nvm install 20
nvm use 20

# Windows (推荐 nvm-windows)
# https://github.com/coreybutler/nvm-windows/releases
```

### Q: Chrome 扩展加载失败

A: 检查 `manifest.json` 是否合法（JSON 格式错误会导致加载失败）。

### Q: WebSocket 连接不上

A: 
1. 确认 VS Code Bridge Server 已启动（看 VS Code 输出面板或 Bridge Panel）
2. 确认端口 `17321` 未被占用：`lsof -i :17321`（macOS/Linux）或 `netstat -ano | findstr 17321`（Windows）

### Q: 自动上传没反应

A: 
1. 确认 ChatGPT 页面已加载并且扩展 content script 已注入（DevTools Console 无报错）
2. 目前自动上传依赖：
   - macOS：尝试发送 `⌘U` 快捷键
   - 通用：尝试点击菜单中的「添加照片和文件」
3. 如果上述都不行，请提供 ChatGPT 页面「附件/上传按钮」附近的 HTML，我来补充 selector

---

## 7. 参考链接

- [Chrome MV3 迁移指南](https://developer.chrome.com/docs/extensions/develop/migrate)
- [VS Code 扩展 API](https://code.visualstudio.com/api)
- [WebSocket API (MDN)](https://developer.mozilla.org/en-US/docs/Web/API/WebSocket)

