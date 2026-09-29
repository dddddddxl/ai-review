# AI Review 新版预览

Grafana 风格的自定义只读看板，不是 Grafana 实例。

在项目根目录运行：

```powershell
node scripts/preview-dashboard-next.mjs --port 4180
```

- 新版：http://127.0.0.1:4180/next/
- 保留的本地旧版：http://127.0.0.1:4180/ （口令可填 preview）
- 测试状态：`/next/?state=empty`、`?state=error`、`?state=unauthorized`

只绑定本机，全部使用合成演示数据，不读取线上密钥或任务状态。不要将此预览服务器部署到公网。
时间切换作用于所选范围指标和趋势；累计排行、累计构成和近七天活跃仓库各自保留标注口径。
趋势按 UTC 自然日聚合，不等同于滚动窗口；推理 Token 已包含在输出中。
新版文件独立位于 public/next，原 public 文件及后端未替换，生产路由未接入，未部署。
修改资源后需重启预览服务器。
