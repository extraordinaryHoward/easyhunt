# Easyhunt

Easyhunt 桌面版默认直接进入本地工作台，不需要账号、短信、PostgreSQL 或 Redis。职位与简历索引写入 Electron 用户数据目录的 `dataRoot/workspace.json`；候选人内容写入同目录的 `dataRoot/resume/`。BOSS 自动化仍要求在任务启动前输入平台绑定手机号、签署委托协议，并支持频率限制和人工接管。

## 直接打开

安装或打开 `desktop/release/` 下的 Easyhunt 应用即可。源码开发时，分别在 `rpa-engine/`、`user-webapp/`、`desktop/` 运行 `npm ci`，然后在仓库根目录执行：

```bash
npm run build
npm --prefix desktop start
```

新职位向导在本地用可核对 JD 原文的规则生成初始画像，用户可在工作台修改。标准 BOSS 采集可用；目标画像 Agent、跨账户分享与云端积分在本地模式下停用。猎聘和智联目前没有自动化 skill。候选人卡片形成的是带证据的预览；完整 PDF 简历仍需第 4 阶段本地流水线处理。

## 可选的云服务模式

需要短信登录、云端账户、LLM Agent 与协作分享时，先配置 `server/.env.example` 所列的 PostgreSQL、Redis、JWT、分享密钥和短信发送方式，然后运行 `npm --prefix server run migrate` 与 `npm --prefix server run dev`。用以下命令重新构建工作台，并启动桌面端：

```bash
VITE_CLOUD_MODE=remote npm --prefix user-webapp run build
npm --prefix desktop start
```

云服务默认地址为 `http://127.0.0.1:4320`，可通过 `EASYHUNT_CLOUD_BASE_URL` 指向其他地址。`DEV_SMS_CODE=true` 仅允许本机开发，验证码打印在服务端终端；正式短信由 `SMS_WEBHOOK_URL` 的适配服务发送。云服务不会存储原始 PDF；分享只上传用户确认选择的文字内容。

## 构建

- `npm run build`：构建 RPA、工作台和 Electron。
- `npm run dist:mac`：生成 macOS DMG 与 ZIP。
- 在 Windows 主机运行 `npm run dist:win`：生成 NSIS 安装包。也可手动触发 `.github/workflows/desktop-build.yml`。

未配置 `EASYHUNT_UPDATE_URL` 时不会检查更新。发布前需为 macOS 安装包正式签名并公证，部署云服务与更新 feed。
