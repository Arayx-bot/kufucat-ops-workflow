---
name: kufucat-ops
description: Kufucat 本地运维入口：检查或选择既有工作流，操作 Shopify 页面规格，发布 R2 素材，估算或调用视频生成，检查社媒发布条件。SEO 选题与内容判断使用已有 kufucat-seo-workflow。
---

# Kufucat 操作入口

覆盖 TOOL-017、019–022。先resolve本文件，从本目录及祖先查找tools/harness/route.rb所在源码包；命令从源码包执行，业务上下文只从KUFUCAT_PROJECT_ROOT指定的用户工作区读取。先读本包README，不把空模板当真实业务配置。先读 `harness/RULES.md`，从 `harness/ROUTES.yaml` 选择已有 Route，只加载其 required_context 并遵守 allowed_tools。不能为适配本 Skill 改 Route 放开权限，也不建立新 Harness/Agent。

## 必须确认的动作

**备份、上传、修改线上页面（包括隐藏草稿）、付费生成、删除**：先说明动作、具体文件/页面/目标、影响范围、预计费用和预算上限，等用户对该次范围确认后执行。零外部费用也要说明；无法估算则说明未知并停下。已有对同一明确动作和范围的确认有效，不重复询问。非交互会话无法取得确认时只给方案。不把批准文案或规格当作上传/发布授权；不得自动付费重试、覆盖正式素材或修改线上页面。

## 工作流与配置（#17）

说法：**检查 Kufucat 工作流配置／给这项任务选择已有流程**。

读 [工作流与页面](references/workflow-pages.md)。只读 `ruby tools/harness/validate.rb` 校验配置，`ruby tools/harness/route.rb ROUTE_ID` 返回已有执行包。纯检查不建任务合同、不写 State/Trace/Ledger；正式执行才按项目 AGENTS 的合同与 Eval 规则处理。

## Shopify 页面（#19）

说法：**读取这个 Shopify 页面状态／按规格生成隐藏草稿／校验页面规格**。

读 [工作流与页面](references/workflow-pages.md)。`plan` 为离线规格检查；`status` 为读取远程状态，会使用已有凭据机制，但不能输出完整 page 正文/个人信息。隐藏写入、发布和 SEO 修改均需确认。意图/SEO 业务门槛引用已有 kufucat-seo-workflow，不在本入口重复制定。

## R2 素材（#20）

说法：**上传这份已批准素材到 Kufucat R2／核对发布地址**。

读 [素材与视频](references/assets-video.md)。素材批准与上传授权分开；说明公共可读目标、版本对象路径和费用后等待确认。只检查明确的文件/地址，不遍历素材库。

## 视频生成（#21）

说法：**估算视频生成费用／按这份提示词生成视频，预算上限 X**。

读 [素材与视频](references/assets-video.md)。默认 estimate-only 不提交；`--submit` 前再次核对说明过的范围、价格估计、上限和确认，不因失败自动再付费。

## 社媒发布前检查（#22）

说法：**检查素材是否适合 TikTok 发布／检查这组草稿发布条件**。

读 [发布前检查](references/prepublish.md)。只检查不发布；明确实际检测覆盖与 unknown/fail，不能把部分机器规则通过称为整套内容/排程通过。

## 本 Skill 验收

新会话只测试配置校验或流程选择：执行只读 validate/route，不读真实业务素材、钥匙串、环境文件，不联网，不创建合同/记录，不运行上传、备份、页面写入或付费生成。
