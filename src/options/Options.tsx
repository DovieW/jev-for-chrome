import React, { useEffect, useRef, useState } from "react";
import {
  Bot,
  MessageSquare,
  SlidersHorizontal,
  RotateCcw,
  ArrowUpRight,
  Check,
  Eye,
  EyeOff,
  Loader2,
  ChevronRight,
  ShieldCheck,
  History,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { Brand, sendMessage } from "../ui/app";
import { activeJevModel, callJevProvider } from "../shared/providers";
import { voiceApiKey } from "../shared/transcription";
import {
  describeHelperKey,
  isOfficialOpenAI,
  generateFieldText,
} from "../shared/text-helper";
import {
  AppSettings,
  DEFAULT_SETTINGS,
  JevProviderType,
  JevRequest,
  TEXT_HELPER_PRESETS,
  TextHelperProvider,
} from "../shared/types";

const TEST_REQUEST: Omit<JevRequest, "model"> = {
  state: {
    task: "Connection test",
    page: {
      url: "https://example.com",
      title: "Example",
      text: "Example Domain",
    },
    elements: [
      { index: "1", label: "More information", operations: ["CLICK"] },
    ],
    recent_actions: [],
  },
  questions: {
    operation: {
      type: "choice",
      criteria: { CLICK: "Click more information", DONE: "Done" },
      instructions: "Pick an operation",
    },
    click_target: {
      type: "choice",
      criteria: { "1": { element: "[1] More information" } },
      instructions: "Which element to click?",
    },
  },
};
type ConnectionState = {
  status: "idle" | "testing" | "success" | "error";
  message?: string;
};
const idle: ConnectionState = { status: "idle" };

function Field({
  id,
  label,
  note,
  children,
}: {
  id: string;
  label: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {note && (
        <p className="text-xs leading-relaxed text-muted-foreground">{note}</p>
      )}
    </div>
  );
}
function SecretInput({
  id,
  value,
  onChange,
  placeholder = "Enter your API key",
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input
        id={id}
        type={visible ? "text" : "password"}
        value={value}
        autoComplete="off"
        spellCheck={false}
        className="pr-10"
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
      />
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="absolute right-1 top-1 size-7 text-muted-foreground"
        aria-label={visible ? "Hide API key" : "Show API key"}
        aria-pressed={visible}
        onClick={() => setVisible(!visible)}
      >
        {visible ? <EyeOff /> : <Eye />}
      </Button>
    </div>
  );
}
function Choice({
  id,
  value,
  onChange,
  items,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  items: Array<[string, string]>;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map(([value, label]) => (
          <SelectItem key={value} value={value}>
            {label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
function ConnectionResult({ state }: { state: ConnectionState }) {
  return (
    <span
      role="status"
      className={`min-w-0 text-xs leading-relaxed ${state.status === "error" ? "text-destructive" : "text-muted-foreground"}`}
    >
      {state.status === "success" && <Check className="mr-1 inline size-3.5" />}
      {state.message}
    </span>
  );
}

export const Options: React.FC = () => {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [ready, setReady] = useState(false);
  const [voiceShortcut, setVoiceShortcut] = useState("Not assigned");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [decisionTest, setDecisionTest] = useState<ConnectionState>(idle);
  const [textTest, setTextTest] = useState<ConnectionState>(idle);
  const decisionVersion = useRef(0);
  const textVersion = useRef(0);
  const dirty = JSON.stringify(settings) !== JSON.stringify(saved);
  const provider = settings.activeProvider;
  const config = settings[provider];
  const helper = describeHelperKey(settings);
  let voiceReady = false;
  try {
    voiceReady = Boolean(voiceApiKey(settings));
  } catch {
    /* configured below */
  }

  useEffect(() => {
    const refreshShortcut = () => {
      void chrome.commands.getAll().then((commands) => {
        setVoiceShortcut(
          commands.find((command) => command.name === "voice-task")?.shortcut ||
            "Not assigned",
        );
      });
    };
    refreshShortcut();
    window.addEventListener("focus", refreshShortcut);
    sendMessage<{ settings: AppSettings }>({ type: "GET_SETTINGS" })
      .then(({ settings }) => {
        setSettings(settings);
        setSaved(settings);
        setReady(true);
      })
      .catch((err) => setError(err.message));
    return () => window.removeEventListener("focus", refreshShortcut);
  }, []);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  const change = (next: AppSettings) => {
    setSettings(next);
    setNotice("");
    setError("");
  };
  const changeConfig = (values: Record<string, string>) => {
    change({ ...settings, [provider]: { ...config, ...values } });
    decisionVersion.current++;
    textVersion.current++;
    setDecisionTest(idle);
    setTextTest(idle);
  };
  const changeHelper = (values: Partial<AppSettings["textHelper"]>) => {
    change({ ...settings, textHelper: { ...settings.textHelper, ...values } });
    textVersion.current++;
    setTextTest(idle);
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setError("");
    const snapshot = settings;
    try {
      await sendMessage({ type: "SAVE_SETTINGS", settings: snapshot });
      setSaved(snapshot);
      setNotice("Changes saved");
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };
  const test = async (kind: "decision" | "text") => {
    const update = kind === "decision" ? setDecisionTest : setTextTest;
    const version = kind === "decision" ? decisionVersion : textVersion;
    const token = ++version.current;
    update({ status: "testing", message: "Connecting…" });
    const started = Date.now();
    try {
      if (kind === "decision")
        await callJevProvider(settings, {
          model: activeJevModel(settings),
          ...TEST_REQUEST,
        });
      else
        await generateFieldText(settings, {
          goal: "Enter the word ready",
          field: { label: "Test field" },
          page: { title: "Connection test", text: "" },
          recent_actions: [],
        });
      if (token === version.current)
        update({
          status: "success",
          message: `Connected in ${Date.now() - started} ms`,
        });
    } catch (err: any) {
      if (token === version.current)
        update({ status: "error", message: err.message });
    }
  };
  const reset = () => {
    change({
      ...DEFAULT_SETTINGS,
      activeProvider: provider,
      typesafe: {
        ...DEFAULT_SETTINGS.typesafe,
        apiKey: settings.typesafe.apiKey,
      },
      openrouter: {
        ...DEFAULT_SETTINGS.openrouter,
        apiKey: settings.openrouter.apiKey,
      },
      openai: { ...DEFAULT_SETTINGS.openai, apiKey: settings.openai.apiKey },
      cloudflare: {
        ...DEFAULT_SETTINGS.cloudflare,
        accountId: settings.cloudflare.accountId,
        apiToken: settings.cloudflare.apiToken,
      },
      textHelper: {
        ...DEFAULT_SETTINGS.textHelper,
        apiKey: settings.textHelper.apiKey,
      },
    });
    decisionVersion.current++;
    textVersion.current++;
    setDecisionTest(idle);
    setTextTest(idle);
  };
  const helperNote =
    helper.source === "openai"
      ? "Using your OpenAI Decisions key."
      : helper.source === "openrouter"
        ? "Using your OpenRouter key."
        : helper.source === "helper"
          ? "Uses this key for text requests."
          : "Add a key here, or use a matching decision-provider key.";

  return (
    <div className="settings-shell">
      <header className="app-header">
        <div className="mx-auto flex h-16 max-w-[1000px] items-center justify-between px-6">
          <Brand />
          <span className="text-xs text-muted-foreground">Preferences</span>
        </div>
      </header>
      <main className="mx-auto max-w-[1000px] px-6 pb-10 pt-10">
        <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">Settings</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Choose your models and customize how Jev runs.
            </p>
          </div>
          <Button variant="outline" asChild>
            <a href="history.html" target="_blank" rel="noopener">
              <History />
              Run history
            </a>
          </Button>
        </div>
        {error && (
          <div
            role="alert"
            className="mb-5 rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive"
          >
            {error}
          </div>
        )}
        <form id="settings-form" onSubmit={save}>
          <fieldset disabled={!ready || saving} className="min-w-0">
            <Tabs defaultValue="models">
              <TabsList className="mb-6">
                <TabsTrigger value="models">
                  <Bot className="mr-1.5 size-4" />
                  Models
                </TabsTrigger>
                <TabsTrigger value="behavior">
                  <SlidersHorizontal className="mr-1.5 size-4" />
                  Behavior
                </TabsTrigger>
              </TabsList>
              <TabsContent value="models" className="mt-0">
                <div className="grid items-stretch gap-5 md:grid-cols-2">
                  <Card className="gap-5 shadow-none">
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2 text-base">
                        <Bot className="size-4 text-muted-foreground" />
                        Decision model
                      </CardTitle>
                      <CardDescription>
                        Chooses the next action on the page.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-5">
                      <Field id="decision-provider" label="Provider">
                        <Choice
                          id="decision-provider"
                          value={provider}
                          onChange={(value) => {
                            change({
                              ...settings,
                              activeProvider: value as JevProviderType,
                            });
                            decisionVersion.current++;
                            setDecisionTest(idle);
                          }}
                          items={[
                            ["openrouter", "OpenRouter"],
                            ["typesafe", "TypeSafe"],
                            ["cloudflare", "Cloudflare Workers AI"],
                            ["openai", "OpenAI Decisions"],
                          ]}
                        />
                      </Field>
                      <Field id="decision-model" label="Model">
                        <Input
                          id="decision-model"
                          value={config.model}
                          spellCheck={false}
                          onChange={(e) =>
                            changeConfig({ model: e.target.value })
                          }
                        />
                      </Field>
                      {provider === "cloudflare" && (
                        <Field id="account-id" label="Account ID">
                          <Input
                            id="account-id"
                            value={settings.cloudflare.accountId}
                            onChange={(e) =>
                              changeConfig({ accountId: e.target.value })
                            }
                          />
                        </Field>
                      )}
                      <Field
                        id="decision-key"
                        label={
                          provider === "cloudflare" ? "API token" : "API key"
                        }
                        note="Stored locally. Sent only to your chosen provider."
                      >
                        <SecretInput
                          key={provider}
                          id="decision-key"
                          value={
                            provider === "cloudflare"
                              ? settings.cloudflare.apiToken
                              : settings[provider].apiKey
                          }
                          onChange={(value) =>
                            changeConfig(
                              provider === "cloudflare"
                                ? { apiToken: value }
                                : { apiKey: value },
                            )
                          }
                        />
                      </Field>
                      <details className="group">
                        <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
                          <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
                          Advanced configuration
                        </summary>
                        <div className="pt-4">
                          <Field id="decision-endpoint" label="Endpoint">
                            <Input
                              id="decision-endpoint"
                              type="url"
                              value={config.endpoint || ""}
                              placeholder={
                                provider === "cloudflare"
                                  ? "Use the account’s default endpoint"
                                  : ""
                              }
                              onChange={(e) =>
                                changeConfig({ endpoint: e.target.value })
                              }
                            />
                          </Field>
                        </div>
                      </details>
                    </CardContent>
                    <CardFooter className="mt-auto flex-wrap gap-3 border-t pt-5">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={decisionTest.status === "testing"}
                        onClick={() => test("decision")}
                      >
                        {decisionTest.status === "testing" ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <ArrowUpRight />
                        )}
                        Test connection
                      </Button>
                      <ConnectionResult state={decisionTest} />
                    </CardFooter>
                  </Card>
                  <Card className="gap-5 shadow-none">
                    <CardHeader>
                      <CardTitle className="flex items-center gap-2 text-base">
                        <MessageSquare className="size-4 text-muted-foreground" />
                        Text model
                      </CardTitle>
                      <CardDescription>
                        Writes field values and chooses starting pages.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-5">
                      <Field id="text-provider" label="Provider">
                        <Choice
                          id="text-provider"
                          value={settings.textHelper.provider}
                          onChange={(value) => {
                            const provider = value as TextHelperProvider;
                            changeHelper({
                              provider,
                              ...TEXT_HELPER_PRESETS[provider],
                            });
                          }}
                          items={[
                            ["openrouter", "OpenRouter"],
                            ["deepseek", "DeepSeek"],
                            ["openai", "OpenAI / Compatible API"],
                          ]}
                        />
                      </Field>
                      <Field id="text-model" label="Model">
                        <Input
                          id="text-model"
                          value={settings.textHelper.model}
                          spellCheck={false}
                          onChange={(e) =>
                            changeHelper({ model: e.target.value })
                          }
                        />
                      </Field>
                      <Field id="text-key" label="API key" note={helperNote}>
                        <SecretInput
                          id="text-key"
                          value={settings.textHelper.apiKey}
                          placeholder="Optional with a matching provider key"
                          onChange={(value) => changeHelper({ apiKey: value })}
                        />
                      </Field>
                      {isOfficialOpenAI(helper.baseUrl) && (
                        <Field
                          id="text-tier"
                          label="Processing"
                          note="Priority offers faster processing at a higher cost."
                        >
                          <Choice
                            id="text-tier"
                            value={settings.textHelper.serviceTier || "default"}
                            onChange={(value) =>
                              changeHelper({
                                serviceTier: value as "default" | "priority",
                              })
                            }
                            items={[
                              ["default", "Standard"],
                              ["priority", "Fast / Priority"],
                            ]}
                          />
                        </Field>
                      )}
                      <details className="group">
                        <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
                          <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" />
                          Advanced configuration
                        </summary>
                        <div className="pt-4">
                          <Field id="text-base-url" label="Base URL">
                            <Input
                              id="text-base-url"
                              type="url"
                              value={settings.textHelper.baseUrl}
                              onChange={(e) =>
                                changeHelper({ baseUrl: e.target.value })
                              }
                            />
                          </Field>
                        </div>
                      </details>
                    </CardContent>
                    <CardFooter className="mt-auto flex-wrap gap-3 border-t pt-5">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={textTest.status === "testing"}
                        onClick={() => test("text")}
                      >
                        {textTest.status === "testing" ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <ArrowUpRight />
                        )}
                        Test connection
                      </Button>
                      <ConnectionResult state={textTest} />
                    </CardFooter>
                  </Card>
                </div>
                <p className="mt-5 flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
                  <ShieldCheck className="mt-px size-3.5 shrink-0" />
                  No telemetry. During a run, page text is shared with your
                  selected models. Password fields are excluded.
                </p>
              </TabsContent>
              <TabsContent value="behavior" className="mt-0">
                <Card className="shadow-none">
                  <CardHeader>
                    <CardTitle className="text-base">Run preferences</CardTitle>
                    <CardDescription>
                      Set the pace and how the assistant interacts with a page.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    <div className="space-y-3">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="font-medium">Voice tasks</p>
                          <p className="mt-1 text-sm text-muted-foreground">
                            Shortcut: <kbd>{voiceShortcut}</kbd>
                          </p>
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            void chrome.tabs.create({
                              url: "chrome://extensions/shortcuts",
                            });
                          }}
                        >
                          Change shortcut
                          <ArrowUpRight />
                        </Button>
                      </div>
                      <p className="text-sm leading-relaxed text-muted-foreground">
                        Press the shortcut to record, then press it again to
                        send your spoken task. Escape cancels. Audio goes to
                        OpenAI’s GPT-4o Mini Transcribe; the transcript runs
                        with your selected decision provider.
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {voiceReady
                          ? "Uses your existing OpenAI key. Microphone access is requested the first time."
                          : "Add an OpenAI key under the text helper or OpenAI Decisions on the Models tab to use voice tasks."}
                      </p>
                    </div>
                    <Separator />
                    <div className="grid max-w-lg gap-5 sm:grid-cols-2">
                      <Field
                        id="max-steps"
                        label="Step limit"
                        note="Maximum actions in a single run."
                      >
                        <Input
                          id="max-steps"
                          type="number"
                          min={1}
                          step={1}
                          value={settings.maxSteps}
                          onChange={(e) =>
                            change({
                              ...settings,
                              maxSteps: Number(e.target.value),
                            })
                          }
                        />
                      </Field>
                      <Field
                        id="step-delay"
                        label="Delay between steps (ms)"
                        note="Use 0 to continue without a delay."
                      >
                        <Input
                          id="step-delay"
                          type="number"
                          min={0}
                          step={1}
                          value={settings.stepDelayMs}
                          onChange={(e) =>
                            change({
                              ...settings,
                              stepDelayMs: Number(e.target.value),
                            })
                          }
                        />
                      </Field>
                    </div>
                    <Separator />
                    <div className="flex items-center justify-between gap-8">
                      <div>
                        <Label htmlFor="show-overlay">Page labels</Label>
                        <p className="mt-1.5 text-sm text-muted-foreground">
                          Show numbered labels on elements the assistant can
                          use.
                        </p>
                      </div>
                      <Switch
                        id="show-overlay"
                        checked={settings.showOverlay}
                        onCheckedChange={(showOverlay) =>
                          change({ ...settings, showOverlay })
                        }
                      />
                    </div>
                    <Separator />
                    <div className="flex items-center justify-between gap-8">
                      <div>
                        <Label htmlFor="trusted-input">Trusted input</Label>
                        <p className="mt-1.5 max-w-xl text-sm leading-relaxed text-muted-foreground">
                          Send clicks and keystrokes as real user input. Chrome
                          may briefly show a debugging banner while input is sent.
                        </p>
                      </div>
                      <Switch
                        id="trusted-input"
                        checked={settings.trustedInput}
                        onCheckedChange={(trustedInput) =>
                          change({ ...settings, trustedInput })
                        }
                      />
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </fieldset>
        </form>
        <footer className="mt-8 flex flex-wrap items-center justify-between gap-4 border-t pt-5">
          <Button
            variant="ghost"
            size="sm"
            disabled={!ready || saving}
            onClick={reset}
            className="text-muted-foreground"
          >
            <RotateCcw />
            Reset defaults
          </Button>
          <div className="flex items-center gap-4">
            <span role="status" className="text-xs text-muted-foreground">
              {!ready
                ? "Loading preferences…"
                : dirty
                  ? "Unsaved changes"
                  : notice || "All changes saved"}
            </span>
            {dirty && (
              <Button
                variant="ghost"
                size="sm"
                disabled={saving}
                onClick={() => {
                  change(saved);
                  decisionVersion.current++;
                  textVersion.current++;
                  setDecisionTest(idle);
                  setTextTest(idle);
                }}
              >
                Discard
              </Button>
            )}
            <Button
              type="submit"
              form="settings-form"
              disabled={!ready || saving || !dirty}
            >
              {saving && <Loader2 className="animate-spin" />}Save changes
            </Button>
          </div>
        </footer>
        <p className="mt-8 text-center text-[11px] text-muted-foreground">
          Jev for Chrome · Community project
        </p>
      </main>
    </div>
  );
};
