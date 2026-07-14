/**
 * Apple Ads (Search Ads) settings section.
 *
 * Connection-foundation panel for src/web/routes/apple-ads.ts. Lets an
 * operator save the 5 Apple Ads API credentials (clientId/teamId/keyId/
 * orgId/privateKey), see which are already configured, and run a live
 * "Test connection" against Apple. A small experimental "Feasibility probe"
 * section is included for verifying whether Apple returns search-popularity
 * data for a handful of keywords — it is NOT wired into any scoring
 * pipeline (see the design doc).
 *
 * Contract (verified against src/web/routes/apple-ads.ts):
 *   GET  /api/appstore/apple-ads/config  -> { success, data: AppleAdsCredentialStatus }
 *   POST /api/appstore/apple-ads/config  -> body requires ALL 5 fields (Zod
 *                                            schema has no partial/optional
 *                                            fields) -> { success }
 *   POST /api/appstore/apple-ads/test    -> { success, data: { ok, orgName?, error? } }
 *   POST /api/appstore/apple-ads/probe   -> { success, data: { state, rowCount, sample, error? } }
 *
 * IMPORTANT: the save route does NOT support partial updates — Apple Ads'
 * Zod schema requires clientId/teamId/keyId/orgId/privateKey to all be
 * non-empty strings. There is no way to change just one field; every save
 * re-submits (and therefore requires re-entering) all five, including the
 * PEM. The form below makes this explicit rather than silently failing.
 */
import { useEffect, useState } from "react";
import { apiFetch } from "../../api";
import { Button } from "../../components";
import { useToast } from "../../components/Toast";
import { AlertTriangle, CheckCircle2, KeyRound, XCircle } from "lucide-react";

interface CredentialStatus {
  readonly clientIdSet: boolean;
  readonly teamIdSet: boolean;
  readonly keyIdSet: boolean;
  readonly orgIdSet: boolean;
  readonly privateKeySet: boolean;
  readonly configured: boolean;
}

interface TestResult {
  readonly ok: boolean;
  readonly orgName?: string;
  readonly error?: string;
}

interface ProbeResult {
  readonly state: string;
  readonly reportId?: string;
  readonly rowCount: number;
  readonly sample: readonly unknown[];
  readonly error?: string;
}

interface FormDraft {
  readonly clientId: string;
  readonly teamId: string;
  readonly keyId: string;
  readonly orgId: string;
  readonly privateKey: string;
}

const EMPTY_DRAFT: FormDraft = {
  clientId: "",
  teamId: "",
  keyId: "",
  orgId: "",
  privateKey: "",
};

const CONFIG_URL = "/api/appstore/apple-ads/config";
const TEST_URL = "/api/appstore/apple-ads/test";
const PROBE_URL = "/api/appstore/apple-ads/probe";

/* ── set/not-set pill ── */
function SetPill({ set }: { readonly set: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full ${
        set ? "bg-success-subtle text-success" : "bg-bg-3 text-muted"
      }`}
    >
      {set ? <CheckCircle2 className="w-2.5 h-2.5" /> : null}
      {set ? "set" : "not set"}
    </span>
  );
}

/* ── one credential field row ── */
function CredentialField({
  id,
  label,
  value,
  onChange,
  set,
  disabled,
  monospace,
  placeholder,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (v: string) => void;
  readonly set: boolean;
  readonly disabled: boolean;
  readonly monospace?: boolean;
  readonly placeholder?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-xs font-medium text-foreground">
          {label}
        </label>
        <SetPill set={set} />
      </div>
      {monospace ? (
        <textarea
          id={id}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={5}
          spellCheck={false}
          className="w-full bg-bg-2 border border-border rounded-md px-2 py-1.5 text-xs font-mono text-foreground focus:outline-none focus:border-accent disabled:opacity-50 resize-y"
        />
      ) : (
        <input
          id={id}
          type="text"
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          className="w-full bg-bg-2 border border-border rounded-md px-2 py-1 text-xs text-foreground focus:outline-none focus:border-accent disabled:opacity-50"
        />
      )}
    </div>
  );
}

/* ── test-connection result banner ── */
function TestResultBanner({ result }: { readonly result: TestResult }) {
  if (result.ok) {
    return (
      <div className="flex items-center gap-2 text-xs text-success bg-success-subtle rounded-md p-2">
        <CheckCircle2 className="w-4 h-4 shrink-0" />
        <span>
          Connected{result.orgName ? (
            <>
              {" "}
              — org: <strong>{result.orgName}</strong>
            </>
          ) : null}
        </span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 text-xs text-danger bg-danger-subtle rounded-md p-2">
      <XCircle className="w-4 h-4 shrink-0" />
      <span>{result.error ?? "Connection failed."}</span>
    </div>
  );
}

/* ── experimental feasibility probe ── */
function FeasibilityProbe() {
  const { error: toastError } = useToast();
  const [keywordsText, setKeywordsText] = useState("");
  const [probing, setProbing] = useState(false);
  const [result, setResult] = useState<ProbeResult | null>(null);

  const keywords = keywordsText
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
    .slice(0, 10);

  async function handleProbe() {
    if (keywords.length === 0) return;
    setProbing(true);
    setResult(null);
    try {
      const res = await apiFetch<{ data: ProbeResult }>(PROBE_URL, {
        method: "POST",
        body: JSON.stringify({ keywords }),
      });
      setResult(res.data);
    } catch {
      toastError("Feasibility probe request failed.");
    } finally {
      setProbing(false);
    }
  }

  return (
    <div className="bg-bg-2 border border-border rounded-lg p-3 flex flex-col gap-3">
      <div>
        <div className="text-xs font-medium text-foreground">Feasibility probe</div>
        <div className="text-xs text-muted mt-0.5">
          Experimental — verifies whether Apple returns search popularity for these
          keywords. Not wired into any scoring pipeline; results are raw diagnostics.
        </div>
      </div>
      <input
        type="text"
        value={keywordsText}
        onChange={(e) => setKeywordsText(e.target.value)}
        placeholder="habit tracker, budget app, sleep sounds (up to 10, comma-separated)"
        disabled={probing}
        className="w-full bg-bg border border-border rounded-md px-2 py-1 text-xs text-foreground focus:outline-none focus:border-accent disabled:opacity-50"
      />
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-faint">{keywords.length}/10 keywords</span>
        <Button
          variant="secondary"
          size="sm"
          onClick={handleProbe}
          disabled={probing || keywords.length === 0}
          loading={probing}
        >
          Run probe
        </Button>
      </div>
      {result && (
        <pre className="bg-bg border border-border rounded-md p-2 text-[10px] text-muted overflow-x-auto whitespace-pre-wrap">
          {JSON.stringify(result, null, 2)}
        </pre>
      )}
    </div>
  );
}

export default function AppleAdsSettings() {
  const { success, error: toastError } = useToast();

  const [status, setStatus] = useState<CredentialStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [draft, setDraft] = useState<FormDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);

  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  async function loadStatus() {
    setLoadingStatus(true);
    try {
      const res = await apiFetch<{ data: CredentialStatus }>(CONFIG_URL);
      setStatus(res.data);
    } catch {
      toastError("Failed to load Apple Ads config status.");
    } finally {
      setLoadingStatus(false);
    }
  }

  useEffect(() => {
    loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function update<K extends keyof FormDraft>(key: K, value: FormDraft[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  const allFilled =
    draft.clientId.trim().length > 0 &&
    draft.teamId.trim().length > 0 &&
    draft.keyId.trim().length > 0 &&
    draft.orgId.trim().length > 0 &&
    draft.privateKey.trim().length > 0;

  async function handleSave() {
    if (!allFilled) return;
    setSaving(true);
    try {
      await apiFetch(CONFIG_URL, {
        method: "POST",
        body: JSON.stringify({
          clientId: draft.clientId.trim(),
          teamId: draft.teamId.trim(),
          keyId: draft.keyId.trim(),
          orgId: draft.orgId.trim(),
          privateKey: draft.privateKey.trim(),
        }),
      });
      success("Apple Ads credentials saved.");
      setDraft(EMPTY_DRAFT);
      setTestResult(null);
      await loadStatus();
    } catch {
      toastError("Failed to save Apple Ads credentials.");
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await apiFetch<{ data: TestResult }>(TEST_URL, { method: "POST" });
      setTestResult(res.data);
    } catch {
      toastError("Test connection request failed.");
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <KeyRound className="w-4 h-4 text-muted" />
        <h3 className="text-sm font-semibold text-foreground">Apple Ads (Search Ads)</h3>
      </div>
      <p className="text-xs text-muted -mt-2">
        Connects to Apple's Search Ads API to read real App Store search-volume signal.
        This is inert — no network calls happen, and it does not affect scoring — until
        credentials are saved and validated below.
      </p>

      <div className="bg-bg-2 border border-border rounded-lg p-3 flex flex-col gap-3">
        {loadingStatus || status === null ? (
          <p className="text-xs text-muted py-1">Loading credential status…</p>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-foreground">Overall status</span>
              <SetPill set={status.configured} />
            </div>

            <div className="flex items-start gap-2 text-xs text-warning bg-warning-subtle rounded-md p-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>
                The save API does not support partial updates — all 5 fields below must
                be filled together, even to change just one. The private key is
                write-only and is never returned by the server, so re-enter it on every
                save.
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <CredentialField
                id="apple-ads-client-id"
                label="Client ID"
                value={draft.clientId}
                onChange={(v) => update("clientId", v)}
                set={status.clientIdSet}
                disabled={saving}
              />
              <CredentialField
                id="apple-ads-team-id"
                label="Team ID"
                value={draft.teamId}
                onChange={(v) => update("teamId", v)}
                set={status.teamIdSet}
                disabled={saving}
              />
              <CredentialField
                id="apple-ads-key-id"
                label="Key ID"
                value={draft.keyId}
                onChange={(v) => update("keyId", v)}
                set={status.keyIdSet}
                disabled={saving}
              />
              <CredentialField
                id="apple-ads-org-id"
                label="Org ID"
                value={draft.orgId}
                onChange={(v) => update("orgId", v)}
                set={status.orgIdSet}
                disabled={saving}
              />
            </div>

            <CredentialField
              id="apple-ads-private-key"
              label="Private Key (PEM)"
              value={draft.privateKey}
              onChange={(v) => update("privateKey", v)}
              set={status.privateKeySet}
              disabled={saving}
              monospace
              placeholder="-----BEGIN EC PRIVATE KEY-----"
            />

            <div className="flex justify-end pt-1">
              <Button
                variant="primary"
                size="sm"
                onClick={handleSave}
                disabled={saving || !allFilled}
                loading={saving}
              >
                Save
              </Button>
            </div>
          </>
        )}
      </div>

      <div className="bg-bg-2 border border-border rounded-lg p-3 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-medium text-foreground">Test connection</div>
            <div className="text-xs text-muted mt-0.5">
              Runs a live check against Apple using the stored credentials.
            </div>
          </div>
          <Button
            variant="secondary"
            size="sm"
            onClick={handleTest}
            disabled={testing}
            loading={testing}
          >
            Test connection
          </Button>
        </div>
        {testResult && <TestResultBanner result={testResult} />}
      </div>

      <FeasibilityProbe />
    </div>
  );
}
