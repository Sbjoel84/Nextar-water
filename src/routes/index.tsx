import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAllRoles, type Role } from "@/lib/permissions";
import { clockSkewMessage, markJustSignedIn } from "@/lib/auth-session";
import { DEPARTMENT_OPTIONS } from "@/lib/departments";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { Loader2, Boxes, BarChart3, ShieldCheck, Users, Eye, EyeOff } from "lucide-react";

const FEATURES = [
  {
    icon: Boxes,
    title: "Inventory & production",
    desc: "Raw materials to finished products, tracked end to end.",
  },
  {
    icon: BarChart3,
    title: "Real-time reporting",
    desc: "Live dashboards across sales, costs, and cash flow.",
  },
  {
    icon: ShieldCheck,
    title: "Role-based security",
    desc: "Granular access, audited down to every action.",
  },
  {
    icon: Users,
    title: "Built for water production",
    desc: "Sachet, bottle and dispenser water on one platform.",
  },
];

// Login card is always Nextar navy, so fields use fixed colours rather than theme tokens.
const FIELD_CLASS =
  "h-12 rounded-md border-white/20 bg-white/10 px-4 text-white shadow-none placeholder:text-white/50 focus-visible:border-[#5fb2f0] focus-visible:ring-1 focus-visible:ring-[#5fb2f0]";

// A plain <Input type="password"> with a toggle to reveal what was typed --
// same input either way, just swaps the rendered type between "password"
// and "text" so the value itself never changes.
function PasswordInput({
  id,
  name,
  autoComplete,
  required,
  minLength,
  value,
  onChange,
  placeholder,
}: {
  id?: string;
  name?: string;
  autoComplete?: string;
  required?: boolean;
  minLength?: number;
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
}) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input
        id={id}
        name={name}
        type={visible ? "text" : "password"}
        autoComplete={autoComplete}
        required={required}
        minLength={minLength}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        className={`${FIELD_CLASS} pr-11`}
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        tabIndex={-1}
        aria-label={visible ? "Hide password" : "Show password"}
        className="absolute inset-y-0 right-0 flex items-center px-3.5 text-white/50 hover:text-white"
      >
        {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </button>
    </div>
  );
}

const STATUS_MESSAGES: Record<string, (reason?: string | null) => string> = {
  pending: () => "Your account is awaiting admin approval. You'll be notified once it's reviewed.",
  rejected: (reason) =>
    reason
      ? `Your registration was declined: ${reason}`
      : "Your registration was declined. Contact an administrator.",
  suspended: () => "Your account has been suspended. Contact an administrator.",
  deactivated: () => "Your account has been deactivated. Contact an administrator.",
};

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "FMIS — Factory Management & Inventory System" },
      {
        name: "description",
        content:
          "Enterprise inventory, sales, production, payroll, and reporting for the Water Factory.",
      },
      { property: "og:title", content: "FMIS — Factory Management & Inventory System" },
      {
        property: "og:description",
        content: "One platform for your water factory. Secure roles, real-time dashboards.",
      },
      { property: "og:type", content: "website" },
    ],
  }),
  component: Landing,
});

function Landing() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [suFullName, setSuFullName] = useState("");
  const [suUsername, setSuUsername] = useState("");
  const [suEmail, setSuEmail] = useState("");
  const [suPhone, setSuPhone] = useState("");
  const [suDepartment, setSuDepartment] = useState("");
  const [suRole, setSuRole] = useState<Role | "">("");
  const [suPassword, setSuPassword] = useState("");
  const [suConfirmPassword, setSuConfirmPassword] = useState("");

  const roles = useAllRoles();
  const requestableRoles = roles.data ?? [];

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) navigate({ to: "/dashboard" });
    });
  }, [navigate]);

  const signIn = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    // Autofilled values don't always trigger React's onChange, which can leave
    // `email`/`password` state stale even though the fields look filled in.
    // Read straight from the submitted form so autofill can't send an empty email.
    const formData = new FormData(e.currentTarget);
    const signInEmail = String(formData.get("email") ?? "").trim();
    const signInPassword = String(formData.get("password") ?? "");
    if (!signInEmail || !signInPassword) {
      return toast.error("Enter your email and password");
    }

    setLoading(true);

    const { data, error } = await supabase.auth.signInWithPassword({
      email: signInEmail,
      password: signInPassword,
    });
    if (error) {
      setLoading(false);
      return toast.error(error.message);
    }

    const skewMessage = clockSkewMessage(data.session.access_token);
    if (skewMessage) {
      setLoading(false);
      await supabase.auth.signOut({ scope: "local" });
      return toast.error(skewMessage, { duration: 15000 });
    }

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("status, rejected_reason")
      .eq("id", data.user.id)
      .single();
    setLoading(false);

    if (profileError || !profile) {
      await supabase.auth.signOut();
      return toast.error("Could not load your account. Contact an administrator.");
    }

    const blockedMessage = STATUS_MESSAGES[profile.status]?.(profile.rejected_reason);
    if (blockedMessage) {
      await supabase.auth.signOut();
      return toast.error(blockedMessage);
    }

    toast.success("Welcome back");
    markJustSignedIn();
    navigate({ to: "/dashboard" });
  };

  const signUp = async (e: React.FormEvent) => {
    e.preventDefault();
    if (suPassword !== suConfirmPassword) return toast.error("Passwords don't match");
    if (!suRole) return toast.error("Select the role you're requesting");

    setLoading(true);
    const { data, error } = await supabase.auth.signUp({
      email: suEmail,
      password: suPassword,
      options: {
        emailRedirectTo: `${window.location.origin}/dashboard`,
        data: {
          full_name: suFullName,
          username: suUsername || undefined,
          phone: suPhone || undefined,
          department: suDepartment || undefined,
          role_requested: suRole,
        },
      },
    });

    // With email confirmation turned off, signUp returns a live session straight away.
    // New accounts are still 'pending' until an admin approves them, so drop that session
    // instead of letting an unapproved user walk into the app.
    if (data?.session) await supabase.auth.signOut();

    setLoading(false);
    if (error) return toast.error(error.message);
    toast.success("Account created. An admin must approve your account before you can sign in.");
  };

  const forgot = async () => {
    if (!email) return toast.error("Enter your email first");
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    if (error) return toast.error(error.message);
    toast.success("Password reset email sent");
  };

  return (
    <div className="flex min-h-screen flex-col bg-[#06112e]">
      {/* Hero */}
      <section className="relative isolate flex flex-1 flex-col justify-center overflow-hidden bg-[#06112e]">
        {/* ?v= busts the browser cache whenever the photo file is replaced. */}
        <img
          src="/assets/nextar-homepage.jpeg?v=20261024"
          alt=""
          aria-hidden="true"
          className="absolute inset-0 -z-20 h-full w-full object-cover object-center"
        />
        {/* Darken only the edges: the headline (left) and form (right) stay
            readable while the lit factory sign in the middle shows through. */}
        <div
          aria-hidden="true"
          className="absolute inset-0 -z-10 bg-gradient-to-r from-[#06112e]/80 via-[#06112e]/15 to-[#06112e]/60"
        />
        <div
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 -z-10 h-1/3 bg-gradient-to-t from-[#06112e]/70 to-transparent"
        />

        <div className="relative mx-auto w-full max-w-6xl px-4 py-12 sm:px-6 lg:py-20">
          <div className="grid items-center gap-8 lg:grid-cols-[1fr_400px] lg:gap-16">
            <div className="text-center text-white duration-700 animate-in fade-in slide-in-from-bottom-4 motion-reduce:animate-none lg:pl-8 lg:text-left">
              <div className="mx-auto h-24 w-64 overflow-hidden rounded-xl bg-white px-3 py-2 shadow-lg sm:h-28 sm:w-72 lg:mx-0 lg:h-36 lg:w-96">
                <img
                  src="/assets/nextar-logo.jpeg"
                  alt="Nextar"
                  className="h-full w-full object-contain"
                />
              </div>
              <h1 className="mt-8 text-2xl font-bold leading-tight sm:text-3xl lg:text-[2rem]">
                Factory Management &<br />
                Inventory System
              </h1>
              <p className="mt-1 text-base text-white/85 lg:text-lg">
                of <strong className="font-semibold text-white">Nextar Table Water</strong>
              </p>
            </div>

            <div className="w-full rounded-2xl border border-[#3f9be8]/25 bg-[#0a2152]/85 p-6 text-white shadow-2xl shadow-black/40 backdrop-blur-md delay-150 duration-700 animate-in fade-in slide-in-from-bottom-6 fill-mode-both motion-reduce:animate-none">
              <Tabs value={mode} onValueChange={(v) => setMode(v as "signin" | "signup")}>
                <TabsContent value="signin" className="mt-0">
                  <form onSubmit={signIn} className="space-y-3.5">
                    <div>
                      <Label htmlFor="email" className="sr-only">
                        Email
                      </Label>
                      <Input
                        id="email"
                        name="email"
                        type="email"
                        autoComplete="email"
                        required
                        placeholder="Email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className={FIELD_CLASS}
                      />
                    </div>
                    <div>
                      <Label htmlFor="password" className="sr-only">
                        Password
                      </Label>
                      <PasswordInput
                        id="password"
                        name="password"
                        autoComplete="current-password"
                        required
                        placeholder="Password"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={forgot}
                      className="text-xs text-[#5fb2f0] underline underline-offset-2 hover:text-[#9fd3fa]"
                    >
                      Forgot your password?
                    </button>
                    <Button
                      type="submit"
                      disabled={loading}
                      className="mt-3 h-12 w-full rounded-md bg-[#1677d2] text-sm font-bold uppercase tracking-wider text-white hover:bg-[#1d86e6]"
                    >
                      {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Sign in
                    </Button>
                  </form>

                  <div className="mt-5 text-center text-sm text-white/70">
                    <p>No account yet?</p>
                    <button
                      type="button"
                      onClick={() => setMode("signup")}
                      className="mt-1 text-sm font-bold uppercase tracking-wide text-[#5fb2f0] underline underline-offset-4 hover:text-[#9fd3fa]"
                    >
                      Sign up
                    </button>
                  </div>
                </TabsContent>

                <TabsContent value="signup" className="mt-0">
                  <form onSubmit={signUp} className="space-y-3.5">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label htmlFor="su-name" className="sr-only">
                          Full name
                        </Label>
                        <Input
                          id="su-name"
                          required
                          placeholder="Full name"
                          value={suFullName}
                          onChange={(e) => setSuFullName(e.target.value)}
                          className={FIELD_CLASS}
                        />
                      </div>
                      <div>
                        <Label htmlFor="su-username" className="sr-only">
                          Username
                        </Label>
                        <Input
                          id="su-username"
                          placeholder="Username"
                          value={suUsername}
                          onChange={(e) => setSuUsername(e.target.value)}
                          className={FIELD_CLASS}
                        />
                      </div>
                    </div>

                    <div>
                      <Label htmlFor="su-email" className="sr-only">
                        Email
                      </Label>
                      <Input
                        id="su-email"
                        type="email"
                        required
                        placeholder="Email"
                        value={suEmail}
                        onChange={(e) => setSuEmail(e.target.value)}
                        className={FIELD_CLASS}
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label htmlFor="su-phone" className="sr-only">
                          Phone
                        </Label>
                        <Input
                          id="su-phone"
                          type="tel"
                          placeholder="Phone"
                          value={suPhone}
                          onChange={(e) => setSuPhone(e.target.value)}
                          className={FIELD_CLASS}
                        />
                      </div>
                      <div>
                        <Label htmlFor="su-department" className="sr-only">
                          Department
                        </Label>
                        <Select value={suDepartment} onValueChange={setSuDepartment}>
                          <SelectTrigger
                            id="su-department"
                            className={`${FIELD_CLASS} data-[placeholder]:text-white/50`}
                          >
                            <SelectValue placeholder="Department" />
                          </SelectTrigger>
                          <SelectContent>
                            {DEPARTMENT_OPTIONS.map((d) => (
                              <SelectItem key={d} value={d}>
                                {d}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    </div>

                    <div>
                      <Label className="sr-only">Role requested</Label>
                      <Select value={suRole} onValueChange={(v) => setSuRole(v as Role)}>
                        <SelectTrigger
                          className={`${FIELD_CLASS} data-[placeholder]:text-white/50`}
                        >
                          <SelectValue placeholder="Role requested" />
                        </SelectTrigger>
                        <SelectContent>
                          {requestableRoles.map((r) => (
                            <SelectItem key={r.slug} value={r.slug}>
                              {r.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <Label htmlFor="su-password" className="sr-only">
                          Password
                        </Label>
                        <PasswordInput
                          id="su-password"
                          required
                          minLength={6}
                          placeholder="Password"
                          value={suPassword}
                          onChange={(e) => setSuPassword(e.target.value)}
                        />
                      </div>
                      <div>
                        <Label htmlFor="su-confirm" className="sr-only">
                          Confirm password
                        </Label>
                        <PasswordInput
                          id="su-confirm"
                          required
                          minLength={6}
                          placeholder="Confirm"
                          value={suConfirmPassword}
                          onChange={(e) => setSuConfirmPassword(e.target.value)}
                        />
                      </div>
                    </div>

                    <p className="text-xs text-white/70">
                      An Admin reviews and approves new accounts before you can sign in.
                    </p>

                    <Button
                      type="submit"
                      disabled={loading}
                      className="mt-1 h-12 w-full rounded-md bg-[#1677d2] text-sm font-bold uppercase tracking-wider text-white hover:bg-[#1d86e6]"
                    >
                      {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Create account
                    </Button>
                  </form>

                  <div className="mt-5 text-center text-sm text-white/70">
                    <p>Already have an account?</p>
                    <button
                      type="button"
                      onClick={() => setMode("signin")}
                      className="mt-1 text-sm font-bold uppercase tracking-wide text-[#5fb2f0] underline underline-offset-4 hover:text-[#9fd3fa]"
                    >
                      Sign in
                    </button>
                  </div>
                </TabsContent>
              </Tabs>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-[#06112e] text-white">
        <div className="mx-auto w-full max-w-6xl px-4 pt-7 pb-5 sm:px-6">
          <div className="grid gap-8 lg:grid-cols-[1fr_1.4fr_1fr]">
            <div className="h-9 w-32 overflow-hidden rounded-md bg-white px-2 py-1">
              <img
                src="/assets/nextar-logo.jpeg"
                alt="Nextar"
                className="h-full w-full object-contain"
              />
            </div>

            <div>
              <h2 className="text-[10px] font-semibold uppercase tracking-widest text-white/40">
                Platform
              </h2>
              <p className="mt-4 max-w-xs text-xs leading-snug text-white/90">
                Run your Water Factory on one platform. Sales, production, raw materials, payroll,
                and reports, with role-based access and complete audit history.
              </p>
              <p className="mt-1 text-xs text-white/40">Enterprise · Water production</p>
            </div>

            <div className="lg:justify-self-end lg:text-right">
              <h2 className="text-[10px] font-semibold uppercase tracking-widest text-white/40">
                Built by
              </h2>
              <div className="mt-4 flex items-center gap-2.5 text-xs text-white/90 lg:justify-end">
                <img
                  src="/assets/shieldnet-logo.png"
                  alt="ShieldNetCore Tech"
                  className="h-10 w-10 object-contain"
                />
                <span>ShieldNetCore Tech</span>
              </div>
            </div>
          </div>

          <div className="mt-8 text-[10px] text-white/40">© {new Date().getFullYear()} FMIS</div>
        </div>
      </footer>
    </div>
  );
}
