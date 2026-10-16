# 工作流与页面操作

源码从SKILL.md真实位置定位，业务上下文从KUFUCAT_PROJECT_ROOT指定的用户工作区读取。先读本包README。工作流说明在 `harness/README.md`，源码在 `tools/harness/`。配置检查为 `ruby tools/harness/validate.rb`；选择已有流程为 `ruby tools/harness/route.rb ROUTE_ID`，ID 以 ROUTES.yaml 为准，不猜新 ID。只读检查不调用 initialize-local，不创建合同或写状态。

页面源码为 `tools/shopify-page-admin/shopify-page-admin.mjs`，命令接口以源码 printUsage 及 `workflows/seo/workflow.yaml` 为准：

```sh
node tools/shopify-page-admin/shopify-page-admin.mjs plan SPEC.json
node tools/shopify-page-admin/shopify-page-admin.mjs status SPEC.json
node tools/shopify-page-admin/shopify-page-admin.mjs upsert-hidden SPEC.json
node tools/shopify-page-admin/shopify-page-admin.mjs publish SPEC.json --confirm-publish HANDLE
node tools/shopify-page-admin/shopify-page-admin.mjs set-seo SPEC.json --confirm-seo HANDLE
```

`plan` 离线校验，不上传。`status` 会调用 Shopify 身份和读接口，事先明确目标；内部使用现有环境/钥匙串机制，不 cat 环境文件或把凭据传入模型。原始 status 输出可能含页面正文，捕获后只汇总用户指定的状态字段，不回显整页或不必要的个人资料。

所有线上写入（包含 upsert-hidden）须说明 handle、动作、现有/新建对象、可见性、覆盖风险与预计费用，再等用户确认；CLI handle 确认参数不能替代人的确认。先校验计划，再隐藏创建；已有线上页不通过隐藏命令覆盖。SEO 意图与内容仍按现有 kufucat-seo-workflow，不绕过 HUMAN_APPROVAL。执行后只读核对实际状态，失败不自动重复写入。
