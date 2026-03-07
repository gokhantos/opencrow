import type {
  ChannelPlugin,
  ChannelSetupInput,
  ChannelAccountSnapshot,
} from "../plugin-types";
import type { OpenCrowConfig } from "../../config/schema";
import type { Channel } from "../types";
import { createWhatsAppChannel, type WhatsAppChannel } from "./client";

export const whatsappPlugin: ChannelPlugin = {
  id: "whatsapp",

  meta: {
    id: "whatsapp",
    label: "WhatsApp",
    icon: "WA",
    order: 2,
  },

  capabilities: {
    media: true,
    groups: true,
  },

  setup: {
    validateInput(_input: ChannelSetupInput): string | null {
      return null;
    },

    applyConfig(config: OpenCrowConfig, input: ChannelSetupInput): OpenCrowConfig {
      const current = config.channels.whatsapp ?? {
        allowedNumbers: [],
        allowedGroups: [],
        defaultAgent: "opencrow",
      };
      return {
        ...config,
        channels: {
          ...config.channels,
          whatsapp: {
            ...current,
            ...(input.allowedNumbers !== undefined
              ? { allowedNumbers: [...input.allowedNumbers] }
              : {}),
            ...(input.allowedGroups !== undefined
              ? { allowedGroups: [...input.allowedGroups] }
              : {}),
          },
        },
      };
    },
  },

  config: {
    isEnabled(config: OpenCrowConfig): boolean {
      return config.channels.whatsapp !== undefined;
    },

    isConfigured(_config: OpenCrowConfig): boolean {
      // WhatsApp is always "configured" — pairing is done at runtime
      return true;
    },

    getSnapshot(
      config: OpenCrowConfig,
      channel?: Channel,
    ): ChannelAccountSnapshot {
      const waChannel = channel as WhatsAppChannel | undefined;
      return {
        enabled: config.channels.whatsapp !== undefined,
        configured: true,
        connected: channel?.isConnected() ?? false,
        lastError: null,
        pairingState: waChannel?.getPairingState?.() ?? "disconnected",
        qrCode: waChannel?.getQrCode?.() ?? null,
        allowedNumbers: config.channels.whatsapp?.allowedNumbers ?? [],
        allowedGroups: config.channels.whatsapp?.allowedGroups ?? [],
      };
    },

    getAllowedSenders(config: OpenCrowConfig): readonly string[] {
      return config.channels.whatsapp?.allowedNumbers ?? [];
    },
  },

  gateway: {
    createChannel(config: OpenCrowConfig): Channel {
      const defaultAgentId = config.channels.whatsapp?.defaultAgent;
      const agent = defaultAgentId
        ? config.agents.find((a) => a.id === defaultAgentId)
        : undefined;
      const botName =
        agent?.name ??
        config.agent.systemPrompt.match(/You are (\w+)/)?.[1] ??
        "OpenCrow";
      return createWhatsAppChannel(botName);
    },
  },
};
