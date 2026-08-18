import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { AuthProvider } from "@/lib/auth";
import { Toaster } from "@/components/ui/sonner";
import { supabase } from "@/integrations/supabase/client";
import { registerPwa } from "@/lib/pwa/register";
import { ThemeProvider, THEME_INIT_SCRIPT, useTheme } from "@/lib/theme";

/**
 * Origin of the Supabase project, for the preconnect hint below.
 *
 * Read from the same `VITE_SUPABASE_URL` the browser client is built from. It is
 * a public value already inlined into the bundle, and only the origin is used —
 * no key, no path. Wrapped because a malformed value must not take the shell
 * down over a performance hint.
 */
const SUPABASE_ORIGIN = (() => {
  try {
    const raw = import.meta.env.VITE_SUPABASE_URL;
    return raw ? new URL(raw).origin : null;
  } catch {
    return null;
  }
})();

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ThemedToaster() {
  const { theme } = useTheme();
  return <Toaster richColors position="top-right" theme={theme} />;
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold">Something went wrong</h1>
        <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      // Light-mode default; THEME_INIT_SCRIPT rewrites it before paint and the
      // toggle keeps it in sync, so mobile browser chrome tracks the theme.
      { name: "theme-color", content: "#fbfdfd" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
      { name: "apple-mobile-web-app-title", content: "MilaServ Portal" },
      { name: "mobile-web-app-capable", content: "yes" },
      { title: "MilaServ Portal" },
      {
        name: "description",
        content: "MilaServ Portal — orders, complaints, call center & sales analytics",
      },
      { property: "og:title", content: "MilaServ Portal" },
      { name: "twitter:title", content: "MilaServ Portal" },
      {
        property: "og:description",
        content: "MilaServ Portal — orders, complaints, call center & sales analytics",
      },
      {
        name: "twitter:description",
        content: "MilaServ Portal — orders, complaints, call center & sales analytics",
      },
      {
        property: "og:image",
        content:
          "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/d54672b7-3fc3-4317-ab56-89d50fe3188a/id-preview-3f91742d--ee0d9841-3e00-4fc2-b9e5-873ee8568720.lovable.app-1783438085088.png",
      },
      {
        name: "twitter:image",
        content:
          "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/d54672b7-3fc3-4317-ab56-89d50fe3188a/id-preview-3f91742d--ee0d9841-3e00-4fc2-b9e5-873ee8568720.lovable.app-1783438085088.png",
      },
      { name: "twitter:card", content: "summary_large_image" },
      { property: "og:type", content: "website" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "manifest", href: "/site.webmanifest" },
      // Open the connection to Supabase while the JS is still downloading.
      //
      // Measured, not guessed: the first Supabase request of a page load takes
      // ~440-580ms on a cold socket against ~180ms once one is established, and
      // nothing warms it, so the DNS + TCP + TLS handshake was starting only
      // after the bundle had loaded and `AuthProvider`'s effect had run — at
      // ~165-307ms into the load, directly in front of the auth round-trip that
      // gates the whole app shell. `crossOrigin` matters: the requests carry an
      // Authorization header, so without it the browser would warm an anonymous
      // connection the app then cannot use.
      //
      // Built from the same env var the client is constructed from, so it cannot
      // point somewhere the app does not talk to. `dns-prefetch` follows as the
      // fallback for the handful of browsers that ignore `preconnect`.
      ...(SUPABASE_ORIGIN
        ? [
            { rel: "preconnect", href: SUPABASE_ORIGIN, crossOrigin: "anonymous" as const },
            { rel: "dns-prefetch", href: SUPABASE_ORIGIN },
          ]
        : []),
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    // THEME_INIT_SCRIPT sets `class` and `color-scheme` on <html> before React
    // hydrates, which is by design — it is what prevents the first-paint flash.
    // Without this, React reports those attributes as a hydration mismatch.
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();
  const router = useRouter();
  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_IN" || event === "SIGNED_OUT" || event === "USER_UPDATED") {
        router.invalidate();
        if (event !== "SIGNED_OUT") queryClient.invalidateQueries();
      }
    });
    return () => sub.subscription.unsubscribe();
  }, [router, queryClient]);
  useEffect(() => {
    void registerPwa();
  }, []);
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AuthProvider>
          <Outlet />
          <ThemedToaster />
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
