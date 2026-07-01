import WarRoomLive from "./WarRoomLive";

/** Dror's scoped War Room — same UI, fixed account slug, no admin global controls. */
export default function WarRoomDror() {
  return <WarRoomLive accountSlug="dror" isAccountScoped />;
}
