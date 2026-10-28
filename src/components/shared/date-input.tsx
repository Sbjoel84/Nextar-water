import { useState } from "react";
import { CalendarIcon, X } from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { fmtDate } from "@/lib/format";
import { cn } from "@/lib/utils";

// Drop-in replacement for <Input type="date">. The browser's own date box
// follows the computer's region setting and shows month/day/year on most
// machines; this always shows day/month/year. The value stays "yyyy-mm-dd"
// and onChange receives { target: { value } }, so call sites written for the
// native input work unchanged.
const toKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fromKey = (v?: string) => (v ? new Date(`${v}T00:00:00`) : undefined);

export function DateInput({
  value,
  onChange,
  min,
  max,
  disabled,
  required,
  id,
  className,
  placeholder = "dd/mm/yyyy",
}: {
  value?: string;
  onChange?: (e: { target: { value: string } }) => void;
  min?: string;
  max?: string;
  disabled?: boolean;
  required?: boolean;
  id?: string;
  className?: string;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = fromKey(value);
  const set = (v: string) => onChange?.({ target: { value: v } });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          disabled={disabled}
          className={cn(
            "flex h-9 w-full items-center gap-2 rounded-md border border-input bg-transparent px-3 py-1 text-left text-base shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
            className,
          )}
        >
          <span className={cn("flex-1 truncate", !value && "text-muted-foreground")}>
            {value ? fmtDate(value) : placeholder}
          </span>
          {value && !required && !disabled ? (
            <X
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground hover:text-foreground"
              aria-label="Clear date"
              onClick={(e) => {
                e.stopPropagation();
                set("");
              }}
            />
          ) : (
            <CalendarIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          captionLayout="dropdown"
          weekStartsOn={1}
          selected={selected}
          defaultMonth={selected ?? fromKey(max) ?? new Date()}
          startMonth={new Date(1940, 0)}
          endMonth={new Date(new Date().getFullYear() + 10, 11)}
          disabled={[
            ...(min ? [{ before: fromKey(min)! }] : []),
            ...(max ? [{ after: fromKey(max)! }] : []),
          ]}
          onSelect={(d) => {
            if (!d) return;
            set(toKey(d));
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
