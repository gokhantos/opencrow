import type { ChannelPlugin, ChannelSetupInput, ChannelAccountSnapshot } from '../plugin-types'
import type { OpenCrowConfig } from '../../config/schema'
import type { Channel } from '../types'
import { createTelegramChannel } from './client'

export const telegramPlugin: ChannelPlugin = {
  id: 'telegram',

  meta: {
    id: 'telegram',
    label: 'Telegram',
    icon: 'TG',
    order: 1,
  },

  capabilities: {
    media: true,
    groups: true,
  },

  setup: {
    validateInput(input: ChannelSetupInput): string | null {
      if (input.enabled && !input.botToken) {
        return 'Bot token is required to enable Telegram'
      }
      return null
    },

    applyConfig(config: OpenCrowConfig, input: ChannelSetupInput): OpenCrowConfig {
      const current = config.channels.telegram
      return {
        ...config,
        channels: {
          ...config.channels,
          telegram: {
            ...current,
            ...(input.botToken !== undefined ? { botToken: input.botToken } : {}),
            ...(input.allowedUserIds !== undefined
              ? { allowedUserIds: [...input.allowedUserIds] }
              : {}),
          },
        },
      }
    },
  },

  config: {
    isEnabled(config: OpenCrowConfig): boolean {
      return Boolean(config.channels.telegram.botToken)
    },

    isConfigured(config: OpenCrowConfig): boolean {
      return Boolean(config.channels.telegram.botToken)
    },

    getSnapshot(config: OpenCrowConfig, channel?: Channel): ChannelAccountSnapshot {
      return {
        enabled: Boolean(config.channels.telegram.botToken),
        configured: Boolean(config.channels.telegram.botToken),
        connected: channel?.isConnected() ?? false,
        lastError: null,
        allowedUserIds: config.channels.telegram.allowedUserIds,
      }
    },

    getAllowedSenders(config: OpenCrowConfig): readonly number[] {
      return config.channels.telegram.allowedUserIds
    },
  },

  gateway: {
    createChannel(config: OpenCrowConfig): Channel {
      const token = config.channels.telegram.botToken
      if (!token) {
        throw new Error('Telegram bot token is not configured')
      }
      return createTelegramChannel(token)
    },
  },
}
