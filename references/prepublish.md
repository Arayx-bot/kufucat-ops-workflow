# 发布前检查

先读本包README的社媒检查配置与权限说明及用户工作区的真实规则契约。命令：

```sh
node 02-social-media-operations/tools/prepublish_check/check.mjs collect AUDIT_CONFIG.json
node 02-social-media-operations/tools/prepublish_check/check.mjs evaluate AUDIT_CONFIG.json
```

“只读”指不修改社交平台状态；collect/evaluate 会在配置指向的本机审计目录写报告，collect 还会访问明确的公共媒体 URL。先说明这些副作用；严格只读验收不运行它们，只解释配置和现有结果。不把软件名“只读”当作不写本机文件的保证。

仅使用指定素材/草稿与现有快照；不自动读取账号全部内容、授权 Buffer、排程或发布。unknown/fail 保留并阻断下一步，人工 pass 不覆盖实际失败。适用规则、时效和输入指纹按既有工具执行，不编造 V/N/NA。提交、发布、上传需额外确认；通过发布前检查不等于得到发布授权。
