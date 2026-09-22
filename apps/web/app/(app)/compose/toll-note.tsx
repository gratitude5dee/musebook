// apps/web/app/(app)/compose/toll-note.tsx — §14.4.4's Toll disclosure,
// rendered verbatim under the composer. The same sentence sits inside the
// ModePicker's Toll option; here it is a standing caption so the contract is
// on-screen even before the picker is opened. Single line on purpose: gate
// check M7.4 greps the literal string.
const TOLL_SENTENCE =
  "Toll — an agent that doesn’t declare itself is served as a person. Toll is a declared contract, not a detection guarantee.";

export function TollContractNote() {
  return (
    <p className="mx-auto mt-4 max-w-[1400px] px-4 text-xs text-muted-foreground md:px-6">
      {TOLL_SENTENCE}
    </p>
  );
}
