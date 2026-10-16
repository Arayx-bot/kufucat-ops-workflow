# kufucat-ops 独立公开包

此包保留实际工具源码及AI工作流说明，使用者需提供自己的项目事实、素材登记、关键词及平台权限。公开包只提供新写的空白配置与虚构页面规格，不含原Kufucat的线上状态、商品事实、素材、渠道、关键词或凭据。

Python3.10+标准库、Node.js20+标准模块及Ruby（YAML/JSON标准库）；社媒媒体检查另需FFmpeg/ffprobe。macOS离线测试，其他平台未实机验证；无GPU要求。缺依赖逐项说明官方来源、网络/空间/权限及费用，由使用者选择安装并复检。其他AI宿主可读说明，自动发现仅Codex入口约定，未替其他宿主验收。

在源码包根执行 `python3 scripts/init_workspace.py --output NEW_USER_WORKSPACE`，目标存在拒绝覆盖。显式设置KUFUCAT_PROJECT_ROOT到用户工作区，然后 `ruby tools/harness/validate.rb` 校验空白结构，`ruby tools/harness/route.rb engineering`读取已有Route。输入模板只有最小engineering/seo路线，远程工具默认不允许；用户必须据真实任务配置工作流和允许工具，不能将模板PASS视为业务或外部授权。

Shopify：`node tools/shopify-page-admin/shopify-page-admin.mjs plan examples/page-spec.json`离线核对虚构规格。真正status和线上写入需要使用者自己设置SHOPIFY_SHOP、SHOPIFY_CLIENT_ID、SHOPIFY_CLIENT_SECRET，或在macOS使用明确的钥匙串service；值不得贴进聊天。隐藏写入也需明确授权，publish/set-seo精确handle确认不能替代人的确认。API版本为源码默认配置，真实使用前核对官方支持，不以离线测试证明当前平台可用。

R2：显式R2_ACCOUNT_ID/R2_BUCKET/R2_PUBLIC_BASE及自己的凭据来源；优先环境变量R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY，macOS可用自选R2_KEYCHAIN_ACCOUNT及service。`--plan`只校验指定文件SHA和目标键，不读取凭据、不联网；--help只读。正常上传必须说明公开可读目标、文件哈希和费用后确认，拒绝覆盖异哈希对象；私人r2.local.json不在包里。

视频适配器：不带--submit仅离线估算，不创建付费任务；真实生成需用户许可、当前价格、自己的KIE_API_KEY和预算上限。KUFUCAT_PROJECT_ROOT指定本机工作区，运行产物不写源码安装目录，不自动重试付费任务。源码估价不代表当前供应商报价。

社媒检查：KUFUCAT_PROJECT_ROOT、KUFUCAT_PREPUBLISH_CONTRACT和KUFUCAT_MEDIA_ORIGIN显式指定用户自己的工作区、已核实规则契约和媒体来源。模板规则为空，不能发布；真实contract字段以check.mjs读取字段为准并需核实平台时效。collect会访问指定公开URL并写报告，evaluate也会写报告；严格只读仅解释参数/已有结果。不自动授权Buffer或执行社媒排程。门槛checks_passed_not_authorization不等于发布许可。

SEO专用流程先核对用户自己的事实、品牌、营销边界与keyword-map：同一意图合并，不以关键词字面差异新建页；HUMAN_APPROVAL不可跳过，隐藏写入、正式发布和SEO修改按当前动作确认；Search Console稀疏数据仅观察。空模板不是一套已验证生产工作流，完整业务语义由使用者据真实材料配置。

离线验证：`python3 -B tests/test_portable.py`只在临时目录初始化模板、校验Route、Shopify plan与未配置规则阻断，不读取钥匙串、不联网、不付费、不操作原项目State/Ledger。实际云端/媒体/SEO业务未验收。MIT候选许可适用于本包原创源码，第三方平台条款及用户素材许可另行核验；正式公开需确认精确文件与产物。
