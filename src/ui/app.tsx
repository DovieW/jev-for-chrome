import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { JevProviderType } from "../shared/types";

export const PROVIDER_LABELS: Record<JevProviderType, string> = {
  openrouter: "OpenRouter",
  typesafe: "TypeSafe",
  cloudflare: "Cloudflare",
  openai: "OpenAI Decisions",
};

export function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <img src="icon32.png" className="size-8" alt="" aria-hidden="true" />
      <span
        className={cn(
          "font-semibold tracking-tight",
          compact ? "text-[15px]" : "text-base",
        )}
      >
        Jev
        <span className="ml-1.5 font-normal text-muted-foreground">
          for Chrome
        </span>
      </span>
    </div>
  );
}

export function Hint({
  text,
  children,
}: {
  text: string;
  children: React.ReactNode;
}) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent>{text}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** Promise wrapper also catches Chrome transport failures, not just provider errors. */
export function sendMessage<T>(message: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      message,
      (response: T & { success?: boolean; error?: string }) => {
        const error = chrome.runtime.lastError;
        if (error)
          reject(new Error(error.message || "The extension is unavailable."));
        else if (!response)
          reject(new Error("The extension did not respond. Try reloading it."));
        else if (response.success === false)
          reject(new Error(response.error || "The request failed."));
        else resolve(response);
      },
    );
  });
}
