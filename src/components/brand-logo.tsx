import lightLogo from "@/assets/milaserv-logo.png.asset.json";
import darkLogo from "@/assets/milaserv-logo-dark.png.asset.json";
import { cn } from "@/lib/utils";

type BrandLogoProps = {
  size?: "sidebar" | "auth";
  className?: string;
};

const sizes = {
  sidebar: "h-10 w-10",
  auth: "h-16 w-16",
} as const;

/**
 * Both marks stay mounted and their opacity is a function of --theme-dark, so
 * the cross-fade is driven by the same interpolation as every colour in the app.
 * Swapping `src` on a single <img> made the logo pop after everything else: it
 * waited on a React commit *and* on the browser decoding the new bitmap.
 */
export function BrandLogo({ size = "sidebar", className }: BrandLogoProps) {
  const img = "absolute inset-0 block h-full w-full object-contain object-center";

  return (
    <div
      className={cn("relative flex shrink-0 items-center justify-center", sizes[size], className)}
    >
      <img
        src={lightLogo.url}
        alt="MilaServ"
        width={512}
        height={389}
        className={cn(img, "theme-mark-light")}
      />
      <img
        src={darkLogo.url}
        alt=""
        aria-hidden
        width={512}
        height={389}
        className={cn(img, "theme-mark-dark")}
      />
    </div>
  );
}
