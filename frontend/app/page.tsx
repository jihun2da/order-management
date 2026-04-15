"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

export default function Home() {
  const router = useRouter();
  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      router.replace(session ? "/orders" : "/login");
    });
  }, [router]);
  return <div className="flex items-center justify-center min-h-screen text-gray-400">로딩중...</div>;
}
