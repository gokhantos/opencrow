import { useState, useEffect } from "react";
import { z } from "zod";
import { QRCodeSVG } from "qrcode.react";
import { setupChannel, requestWhatsAppPairingCode, apiFetch } from "../api";
import { cn } from "../lib/cn";
import { Button, Input, FormField } from "../components";
import { useZodForm } from "../hooks/useZodForm";

interface ChannelSetupFormProps {
  channelId: string;
  snapshot: Record<string, unknown>;
  onSaved: () => void;
}

const telegramSchema = z.object({
  botToken: z.string(),
  allowedUserIds: z.string(),
});

function TelegramSetupForm({
  snapshot,
  onSaved,
}: Omit<ChannelSetupFormProps, "channelId">) {
  const currentIds = (snapshot.allowedUserIds as number[]) ?? [];
  const [apiError, setApiError] = useState("");

  const {
    register,
    handleSubmit,
    formState: { isSubmitting },
  } = useZodForm(telegramSchema, {
    defaultValues: { botToken: "", allowedUserIds: currentIds.join(", ") },
  });

  async function onSubmit(values: z.infer<typeof telegramSchema>) {
    setApiError("");
    try {
      const input: Record<string, unknown> = {};
      if (values.botToken.trim()) {
        input.botToken = values.botToken.trim();
      }
      const parsed = values.allowedUserIds
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map(Number)
        .filter((n) => !isNaN(n));
      input.allowedUserIds = parsed;
      await setupChannel("telegram", input);
      onSaved();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save";
      setApiError(msg);
    }
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="flex flex-col gap-4">
      {apiError && (
        <div className="text-danger text-sm font-mono px-4 py-3 bg-danger-subtle border border-border rounded-md break-words leading-relaxed">
          {apiError}
        </div>
      )}
      <div className="mb-4">
        <FormField label="Bot Token" id="tg-bot-token">
          <Input
            id="tg-bot-token"
            type="password"
            {...register("botToken")}
            placeholder={
              snapshot.configured ? "(unchanged)" : "Enter bot token..."
            }
          />
        </FormField>
      </div>
      <div className="mb-4">
        <FormField label="Allowed User IDs (comma-separated)" id="tg-user-ids">
          <Input
            id="tg-user-ids"
            type="text"
            {...register("allowedUserIds")}
            placeholder="Leave empty to allow all"
          />
        </FormField>
      </div>
      <div>
        <Button type="submit" size="sm" loading={isSubmitting}>
          {isSubmitting ? "Saving..." : "Save"}
        </Button>
      </div>
    </form>
  );
}

const whatsappSchema = z.object({
  allowedNumbers: z.string(),
  allowedGroups: z.string(),
});

function WhatsAppSetupForm({
  snapshot: initialSnapshot,
  onSaved,
}: Omit<ChannelSetupFormProps, "channelId">) {
  const currentNumbers = (initialSnapshot.allowedNumbers as string[]) ?? [];
  const currentGroups = (initialSnapshot.allowedGroups as string[]) ?? [];
  const [liveSnapshot, setLiveSnapshot] = useState(initialSnapshot);

  const pairingState = (liveSnapshot.pairingState as string) ?? "disconnected";
  const qrCode = (liveSnapshot.qrCode as string) ?? null;
  const isConnected = pairingState === "connected";

  const [phoneNumber, setPhoneNumber] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [pairingError, setPairingError] = useState("");
  const [requesting, setRequesting] = useState(false);
  const [pairMode, setPairMode] = useState<"qr" | "code">("qr");
  const [apiError, setApiError] = useState("");

  const {
    register,
    handleSubmit,
    formState: { isSubmitting },
  } = useZodForm(whatsappSchema, {
    defaultValues: {
      allowedNumbers: currentNumbers.join(", "),
      allowedGroups: currentGroups.join(", "),
    },
  });

  useEffect(() => {
    if (isConnected) return;
    const interval = setInterval(async () => {
      try {
        const res = await apiFetch<{
          success: boolean;
          data: { snapshot: Record<string, unknown> };
        }>("/api/channels/whatsapp");
        if (res.success && res.data?.snapshot) {
          setLiveSnapshot(res.data.snapshot);
        }
      } catch {
        // ignore polling errors
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [isConnected]);

  async function handlePair() {
    if (!phoneNumber.trim()) {
      setPairingError("Enter your phone number (country code + number, no +)");
      return;
    }
    setRequesting(true);
    setPairingError("");
    setPairingCode("");
    try {
      const res = await requestWhatsAppPairingCode(phoneNumber.trim());
      if (res.data?.code) {
        setPairingCode(res.data.code);
      }
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to request pairing code";
      setPairingError(msg);
    } finally {
      setRequesting(false);
    }
  }

  async function onSubmit(values: z.infer<typeof whatsappSchema>) {
    setApiError("");
    try {
      const parsed = values.allowedNumbers
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const parsedGroups = values.allowedGroups
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      await setupChannel("whatsapp", {
        allowedNumbers: parsed,
        allowedGroups: parsedGroups,
      });
      onSaved();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save";
      setApiError(msg);
    }
  }

  const statusColor = isConnected
    ? "text-success"
    : pairingState === "pairing" || pairingState === "waiting"
      ? "text-warning"
      : "text-faint";

  const statusLabel = isConnected
    ? "Connected"
    : pairingState === "pairing"
      ? "Pairing..."
      : pairingState === "waiting"
        ? "Waiting for scan"
        : "Disconnected";

  return (
    <div className="flex flex-col gap-4">
      {pairingError && (
        <div className="text-danger text-sm font-mono px-4 py-3 bg-danger-subtle border border-border rounded-md break-words leading-relaxed">
          {pairingError}
        </div>
      )}

      <div className="mb-4">
        <span className="font-heading text-xs font-semibold uppercase tracking-widest text-faint">
          Status
        </span>
        <span className={cn("ml-2 text-sm font-semibold", statusColor)}>
          {statusLabel}
        </span>
      </div>

      {!isConnected && (
        <>
          <div className="flex gap-2 mb-4">
            <Button
              variant={pairMode === "qr" ? "primary" : "secondary"}
              size="sm"
              onClick={() => setPairMode("qr")}
            >
              QR Code
            </Button>
            <Button
              variant={pairMode === "code" ? "primary" : "secondary"}
              size="sm"
              onClick={() => setPairMode("code")}
            >
              Pairing Code
            </Button>
          </div>

          {pairMode === "qr" && (
            <div className="p-5 bg-bg-2 border border-border rounded-lg mb-4 text-center">
              {qrCode ? (
                <>
                  <div className="inline-block p-3 bg-white rounded-lg">
                    <QRCodeSVG value={qrCode} size={200} />
                  </div>
                  <div className="text-sm text-faint mt-2.5">
                    Open WhatsApp &rarr; Linked Devices &rarr; Link a Device
                    &rarr; Scan this QR code
                  </div>
                </>
              ) : (
                <div className="text-faint text-base py-8">
                  Waiting for QR code...
                </div>
              )}
            </div>
          )}

          {pairMode === "code" && (
            <>
              <div className="mb-3">
                <div className="flex gap-2">
                  <div className="flex-1">
                    <Input
                      label="Phone Number"
                      type="text"
                      value={phoneNumber}
                      onChange={(e) => setPhoneNumber(e.target.value)}
                      placeholder="491234567890"
                    />
                  </div>
                  <div className="flex items-end">
                    <Button
                      size="sm"
                      onClick={handlePair}
                      loading={requesting}
                    >
                      {requesting ? "Requesting..." : "Get Code"}
                    </Button>
                  </div>
                </div>
              </div>

              {pairingCode && (
                <div className="p-4 bg-bg-2 border border-border rounded-lg mb-4 text-center">
                  <div className="text-base text-faint mb-1.5">Pairing Code</div>
                  <div className="text-2xl font-bold tracking-widest font-mono text-foreground">
                    {pairingCode.slice(0, 4)}-{pairingCode.slice(4)}
                  </div>
                  <div className="text-sm text-faint mt-2.5">
                    Open WhatsApp &rarr; Linked Devices &rarr; Link a Device
                    &rarr; Link with phone number instead &rarr; Enter this code
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}

      <form onSubmit={handleSubmit(onSubmit)}>
        {apiError && (
          <div className="text-danger text-sm font-mono px-4 py-3 bg-danger-subtle border border-border rounded-md break-words leading-relaxed mb-4">
            {apiError}
          </div>
        )}
        <div className="mb-4">
          <FormField
            label="Allowed Numbers (comma-separated)"
            id="wa-allowed-numbers"
          >
            <Input
              id="wa-allowed-numbers"
              type="text"
              {...register("allowedNumbers")}
              placeholder="491234567890, 441234567890"
            />
          </FormField>
        </div>
        <div className="mb-4">
          <FormField
            label="Allowed Groups (comma-separated group JIDs, empty = all)"
            id="wa-allowed-groups"
          >
            <Input
              id="wa-allowed-groups"
              type="text"
              {...register("allowedGroups")}
              placeholder="905067857210-1561807226@g.us"
            />
          </FormField>
        </div>
        <div>
          <Button type="submit" size="sm" loading={isSubmitting}>
            {isSubmitting ? "Saving..." : "Save"}
          </Button>
        </div>
      </form>
    </div>
  );
}

export default function ChannelSetupForm({
  channelId,
  snapshot,
  onSaved,
}: ChannelSetupFormProps) {
  if (channelId === "telegram") {
    return <TelegramSetupForm snapshot={snapshot} onSaved={onSaved} />;
  }
  if (channelId === "whatsapp") {
    return <WhatsAppSetupForm snapshot={snapshot} onSaved={onSaved} />;
  }
  return (
    <p className="text-faint text-base">
      No setup form available for this channel.
    </p>
  );
}
