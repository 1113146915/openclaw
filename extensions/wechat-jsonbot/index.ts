import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { emptyPluginConfigSchema } from "openclaw/plugin-sdk";
import { wechatPlugin } from "./src/channel.js";
import { setWechatRuntime } from "./src/runtime.js";
import { handleWechatWebhookRequest } from "./src/webhook.js";

const plugin = {
  id: "wechat",
  name: "WeChat",
  description: "WeChat channel plugin powered by json_bot",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    setWechatRuntime(api.runtime);
    api.registerChannel({ plugin: wechatPlugin });
    api.registerHttpHandler(handleWechatWebhookRequest);
  },
};

export default plugin;
