# drgnx changes

What the drgnx fork adds on top of the upstream release it is based on. Upstream's own files, `CHANGELOG.md`
included, stay as upstream released them.

## Features

- `_drgnx/panel` extension (version 1) for drgnx's editor panel, advertised in `agentCapabilities._meta["_drgnx/panel"]` only to a client that sent `clientCapabilities._meta["_drgnx/panel"] = {version: 1}`. Features: `context` (a `_drgnx/context` notification after each turn, from `getContextUsage`) and `before-tool` (a `_drgnx/before_tool` request from the PreToolUse hook; a deny, a failed request or an unreadable answer denies the tool). `drop`, `pin` and `compact-preview` are not advertised: the SDK cannot edit messages or preview a compaction. Adds `AcpClient.extRequest`.
