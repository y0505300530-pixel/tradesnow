import { useState } from "react";
import { PlayCircle } from "lucide-react";
import { youtubeThumbnailUrl } from "@shared/htmlEntities";
import { cn } from "@/lib/utils";

type Props = {
  videoId: string;
  thumbnailUrl?: string | null;
  alt: string;
  className?: string;
  imgClassName?: string;
};

/** YouTube thumb with no-referrer + fallback when ytimg blocks hotlinking. */
export function YoutubeThumbnail({
  videoId,
  thumbnailUrl,
  alt,
  className,
  imgClassName,
}: Props) {
  const canonical = youtubeThumbnailUrl(videoId);
  const initial = thumbnailUrl && !thumbnailUrl.includes("i.ytimg.com")
    ? thumbnailUrl
    : canonical;
  const [src, setSrc] = useState(initial);
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <div className={cn("bg-gray-100 flex items-center justify-center", className)}>
        <PlayCircle className="w-6 h-6 text-gray-300" />
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      referrerPolicy="no-referrer"
      loading="lazy"
      className={imgClassName ?? className}
      onError={() => {
        if (src !== canonical) setSrc(canonical);
        else setFailed(true);
      }}
    />
  );
}
