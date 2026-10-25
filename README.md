# 番号查询 · JAV Code Lookup

粘贴一条 `t.co` 短链 / 推特链接 / FANZA 链接，或者直接敲一个番号，立刻给出 **番号 + 女演员姓名**；再配上本机片库建档，顺手告诉你 **这部是不是已经下过了**。

一个纯前端（Manifest V3）Chrome 扩展 + 一个可选的本机建档服务。没有后端、不上传任何数据。

```
miad 984  →  MIAD-984 · 水野朝陽、吉川あいみ、椎名そら
https://t.co/xxxx  →  PRPM-002 · 逢沢みゆ、彩月七緒   ✓ 已下载
```

> English: a Chrome MV3 extension that resolves a short link (or a raw code) into the JAV product code and the actress names, by scraping public metadata sites. It can also index a local video library and badge results that you already own. Metadata only — no media is hosted or downloaded by this project.

---

## 功能

- **短链展开**：`t.co` 现在返回的是 200 + JS 中间页（`location.replace`），不是 301，所以解析响应体、逐跳展开
- **番号归一**：`miad 984` / `miad.984` / `MIAD-984` / `miad984` 都认；`1start00430`（DMM 的数字前缀 id）也能还原成 `START-430`；`h_1100hzgd00286`（DMM 的 `h_` 型 id）还原成 `HZGD-286`
- **女演员**：javbus（日文原名，最权威）→ njavtv → missav，拿到演员就停
- **本机已下载标记**：扫一遍本地片库生成索引，查到已有片子时卡片上打绿标，显示目录里的分类、文件大小、真实相对路径
- **⚙ 设置**：自定义要扫描的影片目录
- **⟳ 刷新本机库**：页脚一键重建索引，进度实时显示（2000 部约 35 秒）
- **网络自检**：一键测三个数据源，立刻分清「网络/代理问题」还是「番号/解析问题」
- 当前标签页自动带入、剪贴板预填、右键菜单、`Ctrl+Shift+J` 快捷键、最近查询历史

## 安装

1. 下载或 `git clone` 本仓库
2. 打开 `chrome://extensions`，右上角开启 **开发者模式**
3. 点 **加载已解压的扩展程序**，选择本仓库根目录
4. 建议把「番号查询」固定到工具栏；快捷键 `Ctrl+Shift+J`

> 需要能访问 `javbus.com` / `njavtv.com` / `missav.ws` / `t.co`。
> 扩展走的是 **Chrome 自身的代理设置**（系统代理 / PAC 都算），不需要额外配置；
> 不确定通不通时点一下 **网络自检**。

## 用法

| 方式 | 说明 |
|---|---|
| 粘贴短链 | 复制 t.co / 推特 / FANZA 链接，粘进输入框回车 |
| 自动带入 | 当前标签页就是相关站点时，打开扩展自动查询 |
| 剪贴板预填 | 剪贴板里是链接或番号时自动填好（不自动查） |
| 右键菜单 | 链接 / 选中文字 / 页面上右键 →「查番号 / 女演员」 |
| 直接输番号 | `PRPM-002`、`miad 984`、`ssis001` 都行 |
| 批量 | 一行一个，或用逗号分隔：`PRPM-002, SSIS-001` |

## 本机片库建档（可选）

目录约定（番号优先取「上一级文件夹名」）：

```
<影片库根目录>/
├── 女演员A/
│   ├── ABP-842-C/ABP-842-C.mp4
│   └── ABF-045/ABF-045.mp4
└── 其他/
    └── FC2-1391490/FC2-1391490.mp4
```

### 1. 先手动建档（命令行）

```bash
python tools/scan_local_index.py --root "D:\JAV库"
```

产出 `local-index.json`（默认写在仓库根目录，扩展启动时读取）。默认目录是 `~/Videos/jav`，可用 `--root` 或环境变量 `JAV_LIB_ROOT` 指定。

### 2. 让页脚的「⟳ 刷新本机库」按钮可用（一次性）

浏览器不能自己扫盘，所以按钮通过 **Chrome Native Messaging** 调本机的 Python 脚本（Chrome 按需拉起，无常驻进程、不开端口）：

```bash
python tools/setup_native_host.py            # 安装
python tools/setup_native_host.py --uninstall  # 卸载
```

它会：
1. 从 Chrome 自己的配置（`Preferences` / `Secure Preferences`）里读出**本扩展的真实 ID**（用「路径 hash」推算是对不上的）
2. 生成 `tools/com.hermes.javindex.json`（宿主清单，白名单为 `chrome-extension://<ID>/`）
3. 写注册表 `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.hermes.javindex`（当前用户，无需管理员）

装完到 `chrome://extensions` 点一下扩展的刷新图标。换目录 / 换机器后需要重跑一次（扩展 ID 随路径变化）。

## 工作原理（三个易踩的点）

1. **短链展开**：`t.co` 的跳转有两套形态——老的 301 `Location`，和新的 **200 + JS 中间页**。只靠 `curl -L` 会停在中间页上，必须解析响应体里的 `location.replace()`。
2. **番号提取**：DMM 的 content id 有好几种词形，都得认：`?id=1start00430` → `START-430`（那个 `1` 是 DMM 的编号花样）；`200gana1234` 里的 `200` **是厂牌名的一部分**；`h_1100hzgd00286` 里的 `h_1100` 是 **片商编号 + 前缀**，番号只有后面的 `HZGD-286`。所以把 id 拆成 `(数字前缀)(字母段)(数字段)` 后**同时生成候选**，拿数据源当裁判，谁查得到演员用谁。
   ⚠️ 还有个坑：URL 里明明有 `id=` 却解析不出来时，**不要**去抓页面正文找番号 —— DMM 会跳到 `age_check` 页，那页的推荐榜里随便就能翻出别的番号（实测把 `HZGD-286` 报成了 `RED-200`）。这种情况直接报「识别不出番号：DMM id = xxx」。
3. **本机匹配 key**：两端都归一成 `PREFIX-整数`（`ABF-045` → `ABF-45`），JS 侧 `normKey()`、Python 侧 `norm_key()` **必须保持一致**，否则「已下载」永远标不出来。

其他坑（踩过的）：

- **改了 `sw.js` 不生效？** Chrome 按扩展 **version** 缓存 service worker 脚本，改 `sw.js` 必须同时升 `manifest.json` 的 `version`，否则跑的还是旧代码（表现为 `Receiving end does not exist`）。
- **别按数字过滤番号**：`ABF-360`、`SSIS-264`、`FSDSS-720` 都是真番号，把 `360/720/264` 当分辨率排掉会误杀一大片。
- **FC2 这类「字母夹数字」厂牌**：`FC2-1391490` 用普通「字母段+数字段」正则匹配不到，需要一条专用规则（数字段要求 5~7 位，避免误伤）。
- **扫描性能**：`os.walk` + `os.path.getsize` 走两遍元数据，换成 `os.scandir` 递归 + `DirEntry.stat()`（Windows 走 dirent 缓存）能快一半（8.8TB / 2000 部：77s → 35s）。

## 目录结构

```
manifest.json                 扩展声明（MV3）
lookup.js                     核心：短链展开 / 番号归一 / 数据源解析 / 索引 key
popup.html / popup.css / popup.js   查询界面
sw.js                         service worker：右键菜单 + 本机扫描转发
icons/                        图标
tools/scan_local_index.py     片库建档（可单独当 CLI 用）
tools/native_host.py          Native Messaging 宿主（按钮调它跑扫描）
tools/native_host.bat         宿主启动器（Windows，纯 ASCII + CRLF）
tools/setup_native_host.py    安装/卸载宿主（写注册表 + 白名单）
tools/deploy.py               把仓库同步到 Chrome 实际加载的目录
```

## 免责声明

- 本项目**只做元数据查询与本地文件索引**，不提供、不托管、不下载任何影音内容。
- 数据来自第三方公开站点，本站点结构与可用性随时可能变化；如有失效，欢迎提 issue。
- 内容面向 **18 岁以上成年人**，请遵守你所在地区的法律法规。

## License

MIT
