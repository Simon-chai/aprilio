# 宠物系统（自定义宠物接入）

首页右下角的 Agent 形象层。选型结论与候选对比见 [ROADMAP.md](ROADMAP.md#ai-助手宠物形象选型2026-09-09)；
本文只写**怎么接**。

可运行原型：`prototypes/pet/pet-studio.html`（单文件、零依赖，双击即开）。

## 1. 目标与边界

要的是「AI 助手的形象化」，不是独立桌宠：不做全局键鼠监听、透明置顶窗口、托盘、键盘贴图叠加。
在此基础上加一条**用户可换形象**：用户能导入自己的宠物（图片 / 矢量描述 / Live2D 模型），并在设置页切换。

需求里最容易走偏的一点是：**别把「宠物」和「Live2D」绑死**。Live2D 只是可选的一种渲染后端，不是宠物系统的本体。

## 2. 三层架构

```
Agent 事件 ──▶ 事件桥（useAgentPet）──▶ PetRuntime 适配器 ──▶ DOM/Canvas
                     │                        │
               状态机 + 参数插值          三种实现：
                                          vector / sprite / live2d
```

| 层 | 职责 | 与谁解耦 |
| --- | --- | --- |
| 宠物包 `pet.json` | 声明形象用什么 runtime、素材在哪、行为参数 | 与代码解耦：加宠物不改代码 |
| `PetRuntime` 适配器 | 把「状态 + 参数」翻译成具体渲染 | 与事件解耦：Live2D / 图片 / 矢量同一接口 |
| 事件桥 | `AgentEvent` → 状态与参数，含插值、眨眼、idle 微动作 | 与渲染解耦：换后端不用改联动逻辑 |

**关键接口**（形态固定，实现可换）：

```ts
export interface PetRuntime {
  mount(el: HTMLElement, pet: PetDescriptor): Promise<void>;
  setState(s: PetState): void;                       // idle|thinking|talking|working|happy|asleep|sad
  setParams(p: Partial<PetParams>): void;            // 逐帧参数，见 §5
  playMotion?(name: string): void;                   // Live2D 才有，可选
  destroy(): void;
}
```

`ready → 切换宠物 = 换一个 runtime 实例`，不是改组件。

## 3. 宠物包规范（`pet.json`）

按 `runtime` 分几种形态，共用外层字段。`vector` 用参数描述形象，
`vector-layered` / `raster-layered` 用带 slot 名的图层，`sprite` 用序列帧，`live2d` 用 Cubism 模型。

```jsonc
{
  "schema": "aprilio.pet/1",
  "id": "mikan",                 // 目录名，唯一
  "name": "橘子",
  "runtime": "vector",           // vector | vector-layered | raster-layered | sprite | live2d
  "author": "aprilio",
  "version": "1.0.0",
  "behavior": { "idleMotion": "sway", "blinkIntervalMs": [2400, 5200], "tailAmp": 1 }
}
```

**vector**（本次原型的形态：用参数描述形象，零素材、零版权、零依赖，安装包不增体积）

```jsonc
"vector": {
  "species": "猫",
  "palette": { "body": "#f2a75c", "belly": "#fff1da", "ear": "#e08b45", "accent": "#3b2a22" },
  "ears": "triangle", "tail": "long", "whiskers": true, "size": 1, "tailAmp": 1
}
```

**raster-layered**（分层贴图：`vector-layered` 同构，只是每层换成位图）

```jsonc
"canvas": {
  "width": 512, "height": 512, "groundLineY": 478,
  "align": "placed",             // same-size | placed，见下表
  "assetDir": "assets"
},
"layers": [
  { "slot": "pet-body", "file": "body.png", "x": 256, "y": 337, "scale": 1.3, "z": 30 },
  { "slot": "pet-eye-open-l", "file": "eye-open-l.png", "x": 206, "y": 196, "scale": 2.6, "z": 240 }
]
```

`canvas.align` 决定渲染器怎么摆放图层，两种取值语义完全不同：

| align | 含义 | 尺寸来源 | 适用场景 |
| --- | --- | --- | --- |
| `same-size` | 每层与画布等大、原位对齐，`x/y` 只用于算锚点 | 画布尺寸 | PS / Procreate 分层导出（**推荐**，零对齐成本） |
| `placed` | 每层自带自然尺寸，渲染尺寸 = 自然尺寸 × `scale`，中心放在 `(x, y)` | 位图自身尺寸 | 素材板切片 / 尺寸不一的散图 |

能控制导出流程就选 `same-size`；`placed` 是给「部件尺寸不一致」的素材兜底的，
锚点语义（头取底边中点、眼取中心、尾取左侧中点）两者一致。

**sprite**（用户上传自己的图：单帧或序列帧，Shimeji 素材可直接用）

```jsonc
"sprite": {
  "frames": ["frames/0001.png", "frames/0002.png"],
  "fps": { "idle": 4, "talking": 9, "working": 14, "happy": 11 },
  "anchor": "bottom-center"
}
```

**live2d**（标准 Cubism 目录，直接引用 `model3.json`）

```jsonc
"live2d": { "model": "model3.json", "defaultMotion": "Idle", "mouthParam": "ParamMouthOpenY" }
```

> 素材怎么画、图层怎么命名、锚点怎么定 → 见 [§10 素材准备](#10-素材准备)。

## 4. 目录与存储

```
appLocalDataDir/pets/
  <id>/
    pet.json              # 清单
    frames/*.png          # sprite
    model3.json + moc3 + 贴图 + motion3 + exp3   # live2d
```

- 内置包随应用打包进 `public/pets/`，首次启动 seed 到 `appLocalDataDir/pets/`（用户可删）
- 新增 Rust 命令：`list_pets` / `import_pet_dir(src)` / `delete_pet(id)` / `pets_dir()`
  - `import_pet_dir` 用 `fs_extra::dir::copy`，与 BongoCat 的导入机制同构
  - `tauri.conf.json` 的 `assetProtocol.scope` 要加 `$APPLOCALDATA/pets/**`，否则贴图读不出来
  - 新增命令记得挂 `lib.rs` 的 `generate_handler`（见 AGENTS.md 架构约定）
- 「当前用哪只」存 `profile.active_pet_id`，走现有 profile 落库路径

## 5. 参数模型

统一成一组与 Live2D 参数 ID 对齐的浮点参数，适配器各自消费：

| 参数 | 含义 | 对应 Live2D |
| --- | --- | --- |
| `mouthOpenY` | 嘴开合 0~1 | `ParamMouthOpenY` |
| `eyeBallX / eyeBallY` | 眼球偏移 -1~1 | `ParamEyeBallX/Y` |
| `eyeScaleY` | 眼睑开合（眨眼 / 眯眼笑） | `ParamEyeLOpen` |
| `bodyAngleZ` | 身体倾斜 | `ParamBodyAngleZ` |
| `headAngleZ / headDrop` | 点头 / 垂头 | `ParamAngleZ` |
| `breath` | 呼吸缩放 | `ParamBreath` |
| `tailSway` | 尾巴摆幅 | 自定义 |
| `blush / hop / squish` | 腮红 / 跳跃 / 挤压 | 自定义 |

事件桥每帧向目标值做插值（嘴与跳跃用快插值，其余用慢插值），眨眼的随机调度、idle 微动作也在这里 —— 这些是「看起来活着」的关键，不属于任何具体后端。

## 6. Agent 事件桥

对齐 `src/agent/types.ts` 的 `AgentEvent`（只有三个成员，挂钩点很干净）：

| 事件 | 宠物反应 |
| --- | --- |
| `text-delta` | `talking`；按字符推进 `mouthOpenY`（每 ~70ms 一字 + 正弦扰动，模拟口型） |
| `tool-start` | `working`；快速微抖 + 眯眼 + 气泡「正在调用工具…」 |
| `tool-end` | `happy`（跳一下、眯眼笑、腮红）或 `sad`（垂头、眼睑半闭） |
| 空闲 > N 秒 | `idle`，长时间无交互可漂到 `asleep` |

`useAgent.ts` 已有事件回调，宠物订阅它即可，不需要改 Agent 循环。

## 7. 自定义宠物导入流程

| 入口 | 处理 |
| --- | --- |
| 选文件夹（`dialog.open({ directory: true })`） | 校验 `pet.json` → `import_pet_dir` 拷贝到 `pets/<id>/` → 刷新注册表 |
| 选若干图片 | 现场生成 `sprite` 型 `pet.json`（多张按文件自然序当序列帧）→ 同上 |
| 内置包 | 首次启动 seed，不占用户操作 |

校验要点：`id` 合法（非空、无路径分隔符）、`runtime` 在枚举内、声明的素材文件存在、目录体积上限（防误导入大模型）。

## 8. Live2D 正式路线

等事件桥和 vector/sprite 跑顺之后再上，**它是 P2，不是前置**。

```bash
npm i easy-live2d pixi.js          # MPL-2.0 + MIT
```

- Cubism Core（`live2dcubismcore.js`）不在任何 npm 包（Live2D 许可限制），从 Live2D 官网下载放 `public/Core/`，在 `index.html` 用 `<script>` 引入
- `live2dRuntime` 用 `easy-live2d` 的 `Live2DSprite` 包一层：`startMotion` → `playMotion`、`setExpression` → 表情、`setParameterValueById` → `setParams`；库自带 `playVoice` + lip sync，可直接吃 `text-delta`
- pixi.js ~450KB gzip，运行时用 `await import("pixi.js")` 动态加载，只在选中 Live2D 宠物时才拉取，不占首屏

授权（立项前必须收口）：
- **BongoCat 内置猫模型来自 Bongo-Cat-Mver 社区，授权未随 MIT 豁免，不可随本应用分发**；只能参考其代码（MIT）
- POC 用 Live2D 官方示例模型；正式形象单独解决授权，建议自绘扁平简约风，贴合现有设计系统
- Cubism SDK 对小规模经营者免费，但需附声明、禁逆向

## 9. 分阶段落地

| 阶段 | 内容 | 依赖 |
| --- | --- | --- |
| **P0** | `PetRuntime` 接口 + vector 适配器 + 事件桥（本次原型已验证形态） | 无 |
| **P1** | sprite 适配器 + `pets/` 目录 + Rust 三条命令 + 设置页选宠物 | Rust 改动 |
| **P2** | live2d 适配器（dynamic import + Cubism Core 落位） | 模型素材 |
| **P3** | 正式形象选型与授权；可选：宠物对工具结果做语音播报 | P2 |

P0 之所以先做 vector：**零素材、零版权、零依赖**，能最快验证「事件桥 + 状态机 + 自定义宠物包」这套骨架是否正确，
且它顺带把「换宠物 = 换一个 pet.json」的架构立住了。后面接 Live2D 只是多一个适配器。

## 10. 素材准备

**素材形式决定精度上限**：矢量画不出渐变、纹理、厚涂笔触和真实光影，那些只能靠贴图。先按需要的精度选路线，再决定投多少时间。

| 路线 | runtime | 精度上限 | 要准备什么 | 工具 | 单只成本 |
| --- | --- | --- | --- | --- | --- |
| 分层矢量 | `vector-layered` | 扁平插画级 | 1 个分层 SVG（图层按 slot 命名） | Figma / Illustrator / Inkscape | 2~6 小时 |
| **分层贴图** | `raster-layered` | **手绘 / 厚涂 / 3D 渲染级** | 一套同尺寸对齐的分层 PNG | PS / Procreate / Photopea | 1~3 天 |
| 序列帧 | `sprite` | 同上，动画更自由 | 每个状态一组等尺寸透明 PNG | Aseprite / Photoshop | 1~3 天 |
| Live2D | `live2d` | 带网格形变，可做转头 | 精细分层 PSD + mesh + 参数绑定 | Cubism Editor | 1~2 周 |

推荐推进顺序：**分层矢量（先验证交互）→ 分层贴图（提精度）→ 按需上序列帧或 Live2D**。
矢量不是终点，但它能让你在几小时内把「事件桥 + 状态机」跑通；等交互形态定了再换贴图，
slot 名、锚点、变体这套概念完全复用，前面不白做。

### 10.1 分层矢量（迭代最快）

矢量是唯一「改一改就能立刻看到、而且不涨安装包体积」的路线，也最适合反复调形象。

**画布规范**

| 项 | 值 | 说明 |
| --- | --- | --- |
| viewBox | `0 0 512 512` | 与其他宠物素材对齐；用别的尺寸不报错，只是换素材时位置会跳 |
| 中心线 | x = 256 | 水平居中 |
| 脚底线 | y = 478 | 本体底边落在这里；地面阴影另画在它下方 |
| 上下留白 | ≥ 30px | 跳跃、点头时不被裁切 |

**图层命名**（id 精确匹配，大小写敏感）

| id | 必需 | 作用 |
| --- | --- | --- |
| `pet-root` | ✅ | 本体容器，呼吸 / 跳跃 / 整体倾斜挂在它上面 |
| `pet-head` | ✅ | 头部，点头与垂头 |
| `pet-eye-l` / `pet-eye-r` | ✅ | 眼睛容器，眨眼靠缩放它 |
| `pet-mouth` | ✅ | 嘴 |
| `pet-body` | 可选 | 身体 |
| `pet-tail` | 可选 | 尾巴，绕锚点摆动 |
| `pet-ear-l` / `pet-ear-r` | 可选 | 耳朵，可做抖动 |
| `pet-blush-l` / `pet-blush-r` | 可选 | 腮红，改 opacity |
| `pet-shadow` | 可选 | 地面阴影，放在 `pet-root` **之外**，宠物跳起来它不跟着跳 |

**变体元素**（放在对应容器内，用显隐切换——比几何变形好看得多）

| id | 用途 |
| --- | --- |
| `pet-eye-open-l/r` | 睁眼（常态） |
| `pet-pupil-l/r` | 瞳孔，建议把高光一起包进这个组，视线跟随才自然 |
| `pet-eye-happy-l/r` | 笑眼（∪ 向上弯），开心时替换 open |
| `pet-eye-sleep-l/r` | 睡眼（∩ 向下弯），睡觉时替换 open |
| `pet-mouth-closed` | 闭嘴 ω |
| `pet-mouth-open` | 张嘴（口腔色块） |
| `pet-tongue` | 舌头，随张嘴出现 |

变体可选但**强烈建议**：只做几何缩放的宠物像橡皮泥，有专门形态的才像角色。

**旋转锚点**：默认由装配台按包围盒推断（头取底边中点、眼取中心、尾巴取左下角）；
要精确控制就用 `data-pivot="x,y"` 显式声明（用户坐标，绝对坐标）：

```svg
<g id="pet-tail" data-pivot="378,396">
```

推断不准时在装配台里拖蓝点，改完导出进 `pet.json` 就固化了。

**导出注意**

- 用**纯矢量路径**；不要放位图、模糊、发光、投影滤镜——缩放开销大且容易糊
- Figma 导出的 `<style>` + class 会被装配台自动内联，不用担心变黑白
- 避免 `<mask>` 与嵌套 `<clipPath>`，不同渲染器差异大
- 图层顺序就是叠放顺序：尾巴 → 身体 → 头 → 五官

模板：`prototypes/pet/templates/layered-cat.pet.svg`（装配台里也能一键下载）。

### 10.2 分层贴图（精细度最高）

把形象按部件切成多张透明 PNG，每层单独变换。精度上限等于你的画功，效果接近 Live2D 的静态表现；
代价是没有网格形变——头转角度大时会有「纸片感」，金属质感、厚涂笔触这些则完全没问题。

**核心约定：所有图层导出时必须保持同一画布尺寸和位置**，叠加起来就是原图，导入后零对齐成本。
这是 Spine / Live2D 的通行做法，也是唯一能让「分层」不变成负担的做法（逐层裁切 = 手工对齐地狱）。

| 项 | 规范 |
| --- | --- |
| 格式 | 透明 PNG（首选）；WebP / AVIF 更小但兼容性略差 |
| 尺寸 | 统一画布，建议 512×512 或 1024×1024，**不要逐层裁切** |
| 分辨率 | 按显示尺寸 2 倍出图（@2x），HiDPI 屏才不糊：画布 1024 显示 512 正合适 |
| 命名 | `<部位>.png`，如 `body.png` / `left-eye-open.png`，装配台按文件名自动识别 |
| 体积 | 单只 ≤ 1.5MB；超出就降画布或转 WebP |

**部件拆分与命名**（与矢量路线同一套 slot 名，装配台会自动映射；`left-xxx` 与 `xxx-l` 都认）

| 文件名示例 | 映射到 | 作用 |
| --- | --- | --- |
| `body.png` | `pet-body` | 身体，跟随呼吸 |
| `head.png` | `pet-head` | 头，点头 / 垂头 |
| `tail.png` | `pet-tail` | 尾巴，绕锚点摆动 |
| `ear-l.png` / `ear-r.png` | `pet-ear-l/r` | 耳朵，可抖动 |
| `pupil-l.png` | `pet-pupil-l` | 瞳孔**单独一层**，才能做视线跟随 |
| `eye-open-l.png` / `eye-happy-l.png` / `eye-sleep-l.png` | 各变体 | 眨眼与表情切换 |
| `mouth-closed.png` / `mouth-open.png` / `tongue.png` | 各变体 | 说话口型 |
| `blush-l.png` | `pet-blush-l` | 腮红，改透明度 |
| `shadow.png` | `pet-shadow` | 地面阴影，不随本体跳动 |

最少要拆出 `head`、`body`、`eye-open-l/r`、`mouth-closed` 四类才能眨眼和说话；想更活再加 `tail`、`ear-*`、`pupil-*`、`eye-happy-*`、`mouth-open`、`tongue`、`blush-*`。

**拿到分层的两条路**

路线 A · 同尺寸分层导出（手绘 / 有绘图工具时首选）

1. 拿到一张满意的整图（手绘或 AI 生成），先抠掉背景
2. 在 PS / Photopea（免费网页版）里把部件抠到独立图层：复制整图 → 每层删掉不需要的部分 → 得到各部件
3. **每个图层都保留完整画布**，隐藏其他层后逐个导出 PNG
4. 按上表命名，全部拖进 `pet-raster.html`（自动识别为 `same-size`）

手工切割的边界最容易出问题——爪子和身体、耳朵和头的交界处。生成时就要求「正面、四肢分开、纯色背景」，成本会低很多。

路线 B · 一张素材板 → 切片器（只有 AI 出图、不想开 PS 时走这条）

AI 文生图只能出不透明的整图，没法直接给透明通道。所以改成让它**在纯色背景上按网格画 9 个孤立部件**，
再用 `pet-raster.html` 的「素材板切片」把格子切开、抠掉背景、自动镜像补出另一侧：

1. 按 [AI_PROMPTS.md](../prototypes/pet/AI_PROMPTS.md) 的提示词出一张 3×3 素材板
2. 拖进「素材板切片」区域，工具会从四角自动取背景色并推荐容差
3. 调容差 / 羽化，确认每格部位映射，勾选自动镜像
4. 点「切片导入」→ 得到 9 个部件 + 4 个镜像层，按内置骨架粗摆位
5. 再逐个拖拽微调、导出 pet.json（标记为 `placed`）

抠图用的是色度距离而不是 RGB 距离：纯品红和白色的 RGB 距离只有 0.58，抗锯齿边缘会留一圈紫边；
改在 YCbCr 色度平面上算「该像素里非背景成分的占比」，这个值本身近似等于覆盖率，
可以直接当 alpha 用，再反解前景色去掉边缘色溢。

调试工具：`prototypes/pet/pet-raster.html`。拖入图片自动识别部位、同尺寸自动原位对齐、拖拽摆位、
锚点可视化拖拽、图层排序与显隐、动作预览、导出 pet.json。没有素材时点「生成演示图层」，
它会拿矢量模板逐层导出一套贴图，先看效果再决定投不投入。

### 10.3 序列帧

适合像素风、手绘风，以及直接复用现成素材（Shimeji 系的 46 帧 PNG 是事实标准）。

| 项 | 建议 |
| --- | --- |
| 单帧尺寸 | 512×512 以内，**所有帧必须等尺寸** |
| 背景 | 透明 PNG |
| 对齐 | 每帧脚底线一致（可用画布底部 6% 当脚底线） |
| 帧数 | 待机 4~8、说话 2~4、开心 4~6；再多就吃体积 |
| 命名 | `idle_00.png`、`talking_00.png`，按状态分子目录，序号补零（序列帧依赖自然序） |
| 体积 | 单只 ≤ 1MB；超出就降分辨率或减帧 |

预览用 `prototypes/pet/pet-studio.html`，多张图一起拖进去即按序列帧处理。

### 10.4 Live2D

成本最高，只在前面两条验证过交互价值之后再做。

- 工具：**Cubism Editor**
- 素材形态：**分层 PSD**（Cubism 直接读 PSD），分层粒度比矢量路线细得多
- 需要的层：发（前/后）、脸、眉、眼白、瞳孔、睫毛、嘴、舌、牙、身体、四肢、配饰……
- 之后还要在编辑器里做 mesh 蒙皮、参数绑定、动作与表情——**这一步才是主要工作量**
- 参数命名建议对齐 [§5 参数模型](#5-参数模型)，`pet.json` 里用 `mouthParam` 指向实际参数名

授权约束见 [§8](#8-live2d-正式路线)。

## 11. 形象调试工作流

两个装配台，都是单文件、零依赖、双击即开：

| 工具 | 吃进什么 | 用途 |
| --- | --- | --- |
| `prototypes/pet/pet-rig.html` | 分层 SVG | 矢量路线：结构校验、锚点编辑、动作预览、导出 pet.json |
| `prototypes/pet/pet-raster.html` | 分层 PNG / AI 素材板 | 贴图路线：素材板切片抠图、部位自动识别、同尺寸原位对齐、拖拽摆位、图层排序、锚点编辑、导出 pet.json |
| `prototypes/pet/pet-studio.html` | 整图 / 序列帧 | 快速试形象：内置 3 只矢量宠物、导入图片、7 状态机与 Agent 事件模拟 |

三者共用同一套 slot 命名、锚点语义与状态机，素材在几条路线之间可以平移。

提示词手册在 `prototypes/pet/AI_PROMPTS.md`（素材板怎么下指令、背景色怎么选、生成后怎么验收）。

**自检**：`node prototypes/pet/smoke.mjs`。
覆盖切片抠图的数学（色度距离、覆盖率、反混合去色溢、紧裁、镜像、摆位骨架）
与完整画布链路（`getImageData → 抠图 → putImageData → toDataURL → drawImage`）。
画布那一段用 `@napi-rs/canvas` 垫进 jsdom —— jsdom 自身没有 canvas，没有它就只能靠肉眼看 UI。
没装该模块时这一节自动跳过，其余照跑。

```
画分层素材 → 拖进装配台 → 看校验报告 → 调锚点/摆位 → 切状态看动作 → 导出 pet.json
     ↑                                                                   │
     └───────────────────── 改素材，再拖一遍 ──────────────────────────────┘
```

装配台提供：

- **拖 SVG 进来即时预览**，并做结构校验：缺哪个必需图层、眼睛/耳朵是否成对、有无重复 id、画布边缘是否会被动作裁切
- **可视化调锚点**：蓝色十字就是旋转中心，直接拖；也可在列表里选中后用方向键微调（Shift 加速 10px）
- **切换背景**（棋盘 / 浅色 / 深色）：透明区域、浅色毛发在深底发灰这类问题，换背景一眼看出来
- **切换状态**看动作：待机 / 思考 / 说话 / 执行 / 开心 / 睡觉 / 受挫，并有「模拟 Agent 回合」跑真实事件序列
- **导出 pet.json**：图层清单与锚点一并写入，落到 `pets/<id>/` 即可被应用加载

建议的迭代顺序（每步都能独立看到效果，别一次画完）：

1. 只画静态形象（`pet-root` + `pet-head` + 眼 + 嘴），先确认比例与配色
2. 加 `pet-tail` / `pet-ear-l/r`，调锚点，看摆动是否自然
3. 加变体（笑眼、张嘴、舌头），切到「开心」「说话」验证
4. 加 `pet-blush-*` / `pet-shadow` 这类氛围件
5. 精度不够时换成分层贴图——slot 名与锚点照搬，`pet.json` 换个 `runtime` 即可
