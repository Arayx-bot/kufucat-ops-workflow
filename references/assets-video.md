# 素材发布与视频

## R2

先读本包README的R2配置与权限说明，用户工作区另须提供本次实际审批流程。上传命令：

```sh
node 03-asset-center/tools/r2_publish/r2_upload.mjs --file FILE --key VERSIONED_KEY --expected-sha256 APPROVED_SHA
```

FILE 与 SHA 来自已批准的素材登记。上传前说明文件、大小、公共可读 URL/对象路径、版本、费用估计及不覆盖范围，等用户确认。密钥只由工具从钥匙串内部读取，不读出到模型或报告。相同对象不能替换为不同内容；变更提升版本。完成后按工具既有下载校验核对 SHA，失败不登记成功。单独“核对发布地址”只检查给定公共 URL、状态和已批准 SHA，不触发上传或遍历 bucket。

## Kie

先读本包README的视频适配器配置与权限说明；参数以 `kie_adapter.py --help` 为准。默认 CLI：

```sh
python3 -B 03-asset-center/tools/video_generation/kie_adapter.py --duration 6 --aspect-ratio 9:16 --quality low --budget low
```

无 `--submit` 为本地估算，不读取秘密、不创建付费请求。估算是源码费率，不保证现价；真正提交前核对供应商当前官方价格，说明模型、提示词/参考图上传范围、时长、画幅、质量、预计费用及预算上限，并等用户确认后才加 `--submit`。预算参数支持值以源码为准，用户货币上限需核实映射，不能猜 CLI 支持任意数值。

超预算或费用未知停下；失败/超时先查询同一 task 状态，不自动新建付费任务。不覆盖 approved 素材，结果先留忽略的 runtime/candidate 路径。只有估算不叫生成成功；未运行不宣称真实服务已验证。
