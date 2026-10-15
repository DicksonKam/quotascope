import React, { useEffect } from "react";
import { X } from "lucide-react";
import type { DashboardState } from "../shared/api";
import { parseWallTime } from "./time";

export function ObservationDialog({
  form,
  data,
  timezone,
  busy,
  error,
  setError,
  onClose,
  onSave,
}: {
  form: "annotation" | "manual";
  data: DashboardState;
  timezone: string;
  busy: boolean;
  error: string;
  setError: (error: string) => void;
  onClose: () => void;
  onSave: (path: string, payload: unknown) => Promise<void>;
}) {
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const modal = document.querySelector(".modal")!;
    const elements = () =>
      Array.from(
        modal.querySelectorAll<HTMLElement>("button,input,select"),
      ).filter((e) => !e.hasAttribute("disabled"));
    elements()[0]?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const es = elements(),
          first = es[0],
          last = es.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      previous?.focus();
    };
  }, [form]);
  return (
    <div className="modal-backdrop" onClick={() => onClose()}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="modal-close"
          aria-label="Close dialog"
          onClick={() => onClose()}
        >
          <X size={19} />
        </button>
        <h2 id="dialog-title">
          {form === "annotation"
            ? "Add an evidence note"
            : "Add a manual snapshot"}
        </h2>
        <p>
          {form === "annotation"
            ? "Keep notes factual. These are user statements, not provider verification."
            : "A manually entered observation is labeled separately from account reads."}
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const b = new FormData(e.currentTarget);
            if (
              ["at", "end", "reset"].some(
                (key) =>
                  b.get(key) &&
                  !Number.isFinite(parseWallTime(String(b.get(key)), timezone)),
              )
            ) {
              setError(
                "Choose a valid, unambiguous time. For a repeated daylight-saving hour, use the UTC timezone.",
              );
              return;
            }
            if (form === "annotation")
              void onSave("annotations", {
                kind: b.get("kind"),
                label: b.get("label"),
                account: b.get("account"),
                at: parseWallTime(String(b.get("at")), timezone),
                end: b.get("end")
                  ? parseWallTime(String(b.get("end")), timezone)
                  : null,
                verified: b.get("verified") === "on",
              });
            else
              void onSave("manual", {
                used: Number(b.get("used")),
                duration: Number(b.get("duration")),
                reset: parseWallTime(String(b.get("reset")), timezone) / 1000,
                plan: b.get("plan"),
              });
          }}
        >
          {form === "annotation" ? (
            <>
              <label>
                Kind
                <select name="kind">
                  <option value="plan">Verified plan period</option>
                  <option value="coverage">Device coverage</option>
                  <option value="reset">Reset evidence</option>
                </select>
              </label>
              <label>
                Account
                <select
                  name="account"
                  required
                  defaultValue={
                    data.identity === "provider" ? data.latest?.account : ""
                  }
                >
                  <option value="" disabled>
                    Choose an account
                  </option>
                  {(data.accounts ?? []).map((a: string) => (
                    <option value={a} key={a}>
                      {a === data.latest?.account
                        ? "Current account"
                        : a === "unattributed-local"
                          ? "Unattributed local history"
                          : "Other account · " + a.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Note
                <input
                  name="label"
                  required
                  maxLength={160}
                  placeholder="For example: Pro plan confirmed from billing"
                />
              </label>
              <label>
                Start · {timezone}
                <input name="at" type="datetime-local" required />
              </label>
              <label>
                End · {timezone}
                <input name="end" type="datetime-local" />
              </label>
              <label className="checkbox-label">
                <input type="checkbox" name="verified" /> I have independently
                confirmed this statement.
              </label>
            </>
          ) : (
            <>
              <label>
                Used percentage
                <input name="used" type="number" min="0" max="100" required />
              </label>
              <label>
                Window duration in minutes
                <input
                  name="duration"
                  type="number"
                  min="1"
                  defaultValue="10080"
                  required
                />
              </label>
              <label>
                Next reset · {timezone}
                <input name="reset" type="datetime-local" required />
              </label>
              <label>
                Plan code
                <input name="plan" placeholder="unknown" />
              </label>
            </>
          )}
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <button className="button primary" disabled={!!busy}>
            Save {form === "annotation" ? "note" : "snapshot"}
          </button>
        </form>
      </section>
    </div>
  );
}
