export async function loadProductionRoundContext(crcClientId, readClientState, readItemDisputeHistory) {
    if (!/^\d+$/.test(crcClientId)) return null;
    const [state, history] = await Promise.all([
        readClientState(crcClientId),
        readItemDisputeHistory(crcClientId),
    ]).catch(() => [null, null]);
    const currentRoundFloor = Number(state?.current_round);
    if (!Number.isInteger(currentRoundFloor) || currentRoundFloor < 1 || history?.ok !== true) {
        return null;
    }
    return { currentRoundFloor, itemHistory: history.itemHistory ?? {} };
}
