# DSH Plugins

DeepSeek Harness（DSH）Web GUI 的插件集合。

| 插件 | 说明 |
|---|---|
| [side-chat](side-chat/) | 从主聊创建多个临时侧聊：继承创建时的历史、使用原生输入框，不进入普通历史，关闭即结束。 |

## 设计笔记

开发过程里对 DSH 内部接口的调研记录（已脱敏）放在 [docs/notes](docs/notes/)：Codex `/side` 的行为规格、侧栏 tab/资源协议、斜杠命令 API、workspace bundle 格式、Host 侧会话创建与隐藏。

## 安装

每个插件目录都是一个 workspace bundle，在 DSH 的插件管理器里用绝对路径安装：

```bash
plugin_manager install_bundle /path/to/dsh-plugins/<plugin>
```

安装后按插件自己的 README 使用。

## 说明

- 这些插件是按当前 DSH 版本（0.2.1-rc.3）的客户端/主机接口写的，部分能力依赖内部接口，DSH 升级后可能需要跟着调整；具体限制见各插件 README。
- 插件均为个人使用场景编写，改动前请先读对应 README 的“已知限制”。
