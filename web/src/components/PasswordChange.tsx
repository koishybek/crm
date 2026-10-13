// «Смените пароль» (аудит M-8, E30): обязательный экран после входа с временным паролем (его знает тот, кто его выдал)
// и то же окно по желанию — из меню профиля. Правила пароля — общие с сервером (data/passwordRules.ts).
import { useAuthActions } from "@convex-dev/auth/react";
import { KeyRound, LogOut } from "lucide-react";
import { useState, type FormEvent } from "react";
import { PASSWORD_MAX, passwordMin, passwordProblem } from "../data/passwordRules";
import { changeMyPassword } from "../data/securityActions";
import { toast } from "../data/store";
import type { User } from "../data/types";
import { Logo } from "./icons";
import { Button, FormRow, Input, Modal } from "./ui";

function PasswordForm({ me, onDone, submitLabel }: { me: User; onDone: () => void; submitLabel: string }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const min = passwordMin(me.role);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const problem = !current ? "Введите текущий пароль" : (passwordProblem(next, me.role, current) ?? (next !== repeat ? "Новый пароль и повтор не совпадают" : null));
    setError(problem ?? "");
    if (problem) return;
    setBusy(true);
    const r = await changeMyPassword(current, next);
    setBusy(false);
    if (!r.ok) return setError(r.error);
    toast("Пароль изменён. На других устройствах нужно войти заново", "ok");
    onDone();
  };

  const field = (id: string, value: string, set: (v: string) => void, autoComplete: "current-password" | "new-password") => (
    <Input id={id} type="password" autoComplete={autoComplete} maxLength={PASSWORD_MAX} value={value} onChange={(e) => set(e.target.value)} />
  );

  return (
    <form onSubmit={(e) => void submit(e)} className="space-y-4" noValidate>
      <FormRow label="Текущий пароль" required>
        {(id) => field(id, current, setCurrent, "current-password")}
      </FormRow>
      <FormRow label="Новый пароль" required hint={`Не короче ${min} символов. Его будете знать только вы.`}>
        {(id) => field(id, next, setNext, "new-password")}
      </FormRow>
      <FormRow label="Повторите новый пароль" required>
        {(id) => field(id, repeat, setRepeat, "new-password")}
      </FormRow>
      {error && (
        <div role="alert" className="rounded-[10px] bg-bad-bg px-3.5 py-2.5 text-[14px] font-medium text-bad-ink">
          {error}
        </div>
      )}
      <Button type="submit" icon={KeyRound} full disabled={busy}>
        {busy ? "Сохраняем…" : submitLabel}
      </Button>
    </form>
  );
}

/** Обязательный экран: пока временный пароль не сменён, сервер не отдаёт никаких данных. */
export function ForcedPasswordChange({ me }: { me: User }) {
  const { signOut } = useAuthActions();
  return (
    <div className="flex min-h-dvh items-center justify-center bg-[#fbfaf6] px-4 py-8">
      <div className="card w-full max-w-[460px] px-6 py-8 sm:px-10">
        <div className="flex justify-center">
          <Logo />
        </div>
        <h1 className="mt-6 text-center text-[26px] font-bold tracking-[-0.02em] text-ink">Смените пароль</h1>
        <p className="mx-auto mt-2 mb-6 max-w-[360px] text-center text-[15px] leading-snug text-balance text-muted">
          {me.name ? `${me.name.split(" ")[0]}, вы` : "Вы"} вошли с временным паролем — его знает тот, кто его выдал. Придумайте свой, чтобы продолжить.
        </p>
        {/* После смены пароля флаг снимается на сервере, и приложение откроется само. */}
        <PasswordForm me={me} submitLabel="Сохранить и продолжить" onDone={() => undefined} />
        <div className="mt-5 text-center">
          <Button variant="ghost" size="sm" icon={LogOut} onClick={() => void signOut()}>
            Выйти
          </Button>
        </div>
      </div>
    </div>
  );
}

/** «Сменить пароль» по желанию — окно из меню профиля сотрудника и из профиля мастера. */
export function ChangePasswordModal({ me, open, onClose }: { me: User; open: boolean; onClose: () => void }) {
  return (
    <Modal open={open} onClose={onClose} title="Сменить пароль" width={460}>
      {open && <PasswordForm me={me} submitLabel="Сменить пароль" onDone={onClose} />}
    </Modal>
  );
}
