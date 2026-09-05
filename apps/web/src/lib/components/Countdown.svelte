<script lang="ts">
  import { formatCountdownClock, formatCountdownCompact } from "@tornscope/shared";

  /**
   * Live countdown label. Pure rendering: the page computes remaining seconds
   * from absolute timestamps each second and passes them in.
   */
  let {
    seconds,
    style = "clock",
    class: cls = "",
  }: {
    seconds: number | null | undefined;
    style?: "clock" | "compact";
    class?: string;
  } = $props();
</script>

<span class="tnum {cls}">{style === "clock" ? formatCountdownClock(seconds) : formatCountdownCompact(seconds)}</span>
