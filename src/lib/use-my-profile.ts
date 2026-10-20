import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type MyProfile = { id: string; name: string; department: string };

// The signed-in user's name and department, for pre-filling "Recorded by",
// "Requested by", "Department" and similar boxes.
export function useMyProfile() {
  return useQuery({
    queryKey: ["my-profile"],
    queryFn: async (): Promise<MyProfile | null> => {
      const { data: userData } = await supabase.auth.getUser();
      const user = userData.user;
      if (!user) return null;
      const { data, error } = await supabase
        .from("profiles")
        .select("full_name,email,department")
        .eq("id", user.id)
        .maybeSingle();
      if (error) throw error;
      return {
        id: user.id,
        name: data?.full_name || data?.email || user.email || "",
        department: data?.department ?? "",
      };
    },
    staleTime: 5 * 60_000,
  });
}

// Fills an empty box with the signed-in user's name/department once it's
// known. The box stays editable, and anything already typed is kept. Pass
// `active` (e.g. the dialog's open flag) so it refills each time a form that
// clears itself is reopened.
export function usePrefillFromProfile(
  pick: "name" | "department",
  value: string,
  setValue: (v: string) => void,
  active = true,
) {
  const me = useMyProfile();
  const fill = me.data?.[pick] ?? "";
  useEffect(() => {
    if (active && fill && !value) setValue(fill);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, fill]);
}
