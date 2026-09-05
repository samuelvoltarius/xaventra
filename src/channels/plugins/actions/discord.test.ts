import { describe, expect, it } from "vitest";

import type { novaConfig } from "../../../config/config.js";
import { discordMessageActions } from "./discord.js";

describe("discord message actions", () => {
  it("lists channel and upload actions by default", () => {
    const cfg = { channels: { discord: { token: "d0" } } } as novaConfig;
    const actions = discordMessageActions.listActions?.({ cfg }) ?? [];

    expect(actions).toContain("emoji-upload");
    expect(actions).toContain("sticker-upload");
    expect(actions).toContain("channel-create");
  });

  it("respects disabled channel actions", () => {
    const cfg = {
      channels: { discord: { token: "d0", actions: { channels: false } } },
    } as novaConfig;
    const actions = discordMessageActions.listActions?.({ cfg }) ?? [];

    expect(actions).not.toContain("channel-create");
  });
});
