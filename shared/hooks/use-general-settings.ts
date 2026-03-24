import { useState, useEffect, useCallback } from "preact/hooks";

export interface GeneralSettingsData {
  port: number;
  proxy_url: string | null;
  force_http11: boolean;
}

interface GeneralSettingsSaveResponse extends GeneralSettingsData {
  success: boolean;
  restart_required: boolean;
}

export function useGeneralSettings(apiKey: string | null) {
  const [data, setData] = useState<GeneralSettingsData | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [restartRequired, setRestartRequired] = useState(false);

  const load = useCallback(async () => {
    try {
      const resp = await fetch("/admin/general-settings");
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const result: GeneralSettingsData = await resp.json();
      setData(result);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const save = useCallback(async (patch: Partial<GeneralSettingsData>) => {
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (apiKey) {
        headers["Authorization"] = `Bearer ${apiKey}`;
      }
      const resp = await fetch("/admin/general-settings", {
        method: "POST",
        headers,
        body: JSON.stringify(patch),
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({ error: `HTTP ${resp.status}` }));
        throw new Error((body as { error?: string }).error ?? `HTTP ${resp.status}`);
      }
      const result = await resp.json() as GeneralSettingsSaveResponse;
      setData({
        port: result.port,
        proxy_url: result.proxy_url,
        force_http11: result.force_http11,
      });
      setRestartRequired(result.restart_required);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [apiKey]);

  useEffect(() => { load(); }, [load]);

  return { data, saving, saved, error, save, load, restartRequired };
}
