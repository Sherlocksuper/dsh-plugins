# DSH Plugins

DeepSeek Harness（DSH）Web GUI 的插件集合。

| 插件 | 说明 |
|---|---|
| [side-chat](side-chat/) | 输入 `/` 选「侧边栏会话」，在右侧栏开一段临时旁支对话：继承主对话上下文、用原生输入框；使用期间以“未分组”一行存在，关闭标签后归档隐藏。 |

## 安装

每个插件目录都是一个 workspace bundle，在 DSH 的插件管理器里用绝对路径安装：

```bash
plugin_manager install_bundle /path/to/dsh-plugins/<plugin>
```

安装后按插件自己的 README 使用。

## 说明

- 这些插件是按当前 DSH 版本（0.2.1-rc.3）的客户端/主机接口写的，部分能力依赖内部接口，DSH 升级后可能需要跟着调整；具体限制见各插件 README。
- 插件均为个人使用场景编写，改动前请先读对应 README 的“已知限制”。
