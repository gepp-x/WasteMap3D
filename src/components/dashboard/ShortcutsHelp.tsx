"use client";

import { create } from "zustand";
import { COMMON } from "@/lib/i18n";
import { Keyboard } from "lucide-react";
import { useTr } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { SHORTCUTS, closeAllModals, registerModal } from "@/hooks/use-keyboard-shortcuts";
import { ShellDialogContent } from "@/components/motion/AnimatedPanel";
import { Kbd } from "@/components/dashboard/ViewModeSwitch";
import { Dialog, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

/** Open state for the shortcuts dialog (shell-local UI state, not part of the dashboard store). */
export const useShortcutsHelp = create<{ open: boolean; setOpen: (v: boolean) => void }>()((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

// Part of the shell's one-modal-at-a-time contract (openModal / Esc in use-keyboard-shortcuts).
registerModal({ isOpen: () => useShortcutsHelp.getState().open, close: () => useShortcutsHelp.getState().setOpen(false) });

/** Open the help dialog, closing any other modal surface first. */
export function openShortcutsHelp() {
  closeAllModals();
  useShortcutsHelp.getState().setOpen(true);
}

/** Definition list of every shortcut — reused by Settings. */
export function ShortcutList({ className, columns = 1 }: { className?: string; columns?: 1 | 2 }) {
  const t = useTr();
  return (
    <dl className={cn("grid gap-x-6 gap-y-1", columns === 2 && "sm:grid-cols-2", className)}>
      {SHORTCUTS.map((s) => (
        <div key={s.id} className="flex items-center justify-between gap-3 border-b border-ui-border/60 py-1.5 last:border-b-0">
          <dt className="text-[12.5px] text-ui-text-2">{t(s.label)}</dt>
          <dd className="flex shrink-0 gap-1">
            {s.keys.map((k) => (
              <Kbd key={k} className="min-w-6 border-ui-border-strong bg-ui-bg-deep px-1.5 py-0.5 text-[11px] text-ui-text opacity-100">
                {k}
              </Kbd>
            ))}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** "?" help dialog. */
export function ShortcutsHelp() {
  const t = useTr();
  const open = useShortcutsHelp((s) => s.open);
  const setOpen = useShortcutsHelp((s) => s.setOpen);
  return (
    <Dialog open={open} onOpenChange={(v) => setOpen(v)}>
      <ShellDialogContent closeLabel={t(COMMON.close)} className="border border-ui-border bg-ui-surface ring-0 sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-[15px]">
            <Keyboard aria-hidden className="size-4 text-ui-cyan" />
            {t({ th: "แป้นพิมพ์ลัด", en: "Keyboard shortcuts" })}
          </DialogTitle>
          <DialogDescription className="text-[12.5px] text-ui-text-3">
            {t({ th: "ใช้ได้ทุกที่ ยกเว้นขณะพิมพ์ในช่องข้อความ", en: "Available everywhere except while typing in a text field." })}
          </DialogDescription>
        </DialogHeader>
        <ShortcutList />
      </ShellDialogContent>
    </Dialog>
  );
}
