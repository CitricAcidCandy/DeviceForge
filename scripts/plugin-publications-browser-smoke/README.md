# 网页完整功能ZIP发布真实验收

本入口只使用已经冻结的前端dist、Rust市场和宿主，不执行Cargo、npm构建或操作现有预览。真实运行由主代理协调独占窗口。

```powershell
node scripts/plugin-publications-browser-smoke.mjs --release --binary-directory backend/target/x86_64-pc-windows-msvc/release
```

默认市场二进制来自`resource-server/target/release`；宿主目录复用既有`browserSmokeOptions`。每次新建`artifacts/plugin-publications-browser-release-<随机值>`，既有证据不覆盖。用户根、市场数据、Edge配置和端口均为本轮独占；最后正常关闭宿主、回收市场与代理并复查端口及受检产物身份。

## 职责与复用

| 模块 | 职责 |
| --- | --- |
| `../plugin-publications-browser-smoke.mjs` | 串联夹具、独占服务、真实浏览器、独立网络核验与清理 |
| `fixtures.mjs` | 复用既有`browserReleaseFixture`，只在本轮目录补中文字段，生成完整ZIP和共享组件的第二发布 |
| `gateway.mjs` | 透明转发真实市场并记录实际请求摘要；显式注入旧能力404、资源503和等待取消 |
| `controls.mjs` | 操作产品可访问控件，向实际文件输入提供夹具原字节 |
| `scenarios.mjs` | 页面模式切换、完整ZIP检查预览、故障取消、两次发布、发现成套安装、配置及公开SDK调用 |
| `verification.mjs` | 独立核对请求顺序、内容摘要、资源去重、catalog最后提交、最终市场目录和冻结身份 |

直接复用既有`browser-driver.mjs`、`plugin-installations-smoke/host.mjs`、`market.mjs`、`plugin-installations-browser-smoke/bridge.mjs`及其截图和网络采集，不复制驱动、不修改旧验收入口。新增网关另提供本轮夹具及浏览器模块，生产静态dist由原桥接按冻结原字节提供。

## 实际验收范围

先在页面核对默认“完整功能插件”与“独立组件或其他资源”切换。完整ZIP经真实文件输入选入，产品前端自行检查和拆分；测试不通过服务端代发市场。

旧能力404必须产生可读错误且无任何发布POST；资源503必须留可重试表单且无catalog提交；取消暂停的资源请求必须触发真实连接中断，并保留“不表示服务器已经回滚”的提示。注入只在独占代理内，不改变生产市场契约。

首次正常发布必须读取真实`GET /api/v1/capabilities`，对依赖资源逐项HEAD，POST缺失原字节，然后POST在线清单，最后仅POST一个完整功能catalog条目。第二份发布原样共享两份组件和一份工具，仅增加一个工具资源；共享三资源只HEAD，不重复POST，新增资源及新清单才上传。目录最终仅有两份完整功能条目。

页面随后发现并成套安装首份发布，浏览器通过真实公开SDK调用服务器读取宿主绑定的工具；保存中文“配置内容”后停用再启用，SDK再次读取保存值。服务器、浏览器、工具字节均来自本轮小型夹具，不使用十八份官方大包。

## 证据分层

- `report.browser.dom_assertions`、`progress`及`snapshots`记录DOM和可见反馈。
- `report.publication_requests`记录真实市场转发请求的正文摘要、顺序、状态和受控注入；`network_assertions`另作独立判断，不依赖DOM成功提示。
- `report.screenshots`为实际PNG，运行完成后必须由视觉子代理逐张打开，另写该目录`visual-review-result.md`。脚本成功不代替图审。
- `binary_recheck`、`frozen_dist_recheck`与`listeners`记录受检身份稳定及独占端口释放。

该入口不证明十八官方插件、设备业务、移动端、第二物理客户端、长期运行或npx。旧能力场景只验证明确拒绝，不把旧兼容模式的独立包发布当作完整发布降级成功。

## 失败证据与浏览器退出

页面返回结果先写入`report.browser`，再执行浏览器退出核对，避免清理异常覆盖原始DOM断言。`checks.dom`与`checks.network`分别记录，未执行项为`null`，不得将部分成功计为整轮通过。

市场卡片以展示标识的精确`title`定位，不依赖相邻DOM元素的文本空格。独占浏览器禁用扩展及后台模式，正常关闭最多等待十五秒；强制回收仍不计正常退出，也不放宽零退出、端口释放和无归属残留的要求。
