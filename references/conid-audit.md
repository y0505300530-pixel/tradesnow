# ConID Audit — Full Catalogue Status

**Last updated:** 2026-05-28  
**Total tickers in catalogue:** 271 (non-archived)

---

## Summary

| Market | Has ConID | Missing ConID | Coverage |
|--------|-----------|---------------|----------|
| TASE (.TA) | 47 unique | 8 | 85% |
| USA | 161 | 1 (NIKE→NKE) | 99.4% |
| **Total** | **208** | **9** | **95.8%** |

---

## TASE Tickers — Missing ConID (8)

These tickers exist in the catalogue but have no ConID cached. They cannot be traded via Paper Lab.

| Ticker | Reason | Resolution |
|--------|--------|------------|
| ACCL.TA | IBKR does not recognize this symbol | Added to UNTRADEABLE_TICKERS |
| NTO.TA | IBKR does not recognize this symbol | Added to UNTRADEABLE_TICKERS |
| ENERGEAN.TA | Index/ETF — not tradeable | Already in UNTRADEABLE_TICKERS |
| ESTATE15.TA | Index — not tradeable | Already in UNTRADEABLE_TICKERS |
| KSTN.TA | IBKR does not recognize this symbol | Already in UNTRADEABLE_TICKERS |
| PHINERGY.TA | IBKR does not recognize this symbol | Already in UNTRADEABLE_TICKERS |
| TA-BANKS.TA | Index — not tradeable | Already in UNTRADEABLE_TICKERS |
| TA-INS.TA | Index — not tradeable | Already in UNTRADEABLE_TICKERS |

---

## USA Tickers — Missing ConID (1)

| Ticker | Reason | Resolution |
|--------|--------|------------|
| NIKE | Wrong symbol — should be NKE | TICKER_CORRECTIONS maps NIKE→NKE |

---

## TASE Tickers — With ConID (47 unique)

All these tickers are tradeable via Paper Lab IBKR.

| Ticker | ConID | IBKR Exchange | Notes |
|--------|-------|---------------|-------|
| AMOT.TA | 160212261 | TASE | ✅ |
| ARIN.TA | 366247230 | TASE | ✅ |
| ARYT.TA | 160212276 | TASE | ✅ |
| AURA.TA | 523408649 | NASDAQ | ⚠️ Dual-listed |
| AVGD.TA | 648215677 | TASE | ✅ |
| AZRG.TA | 160212266 | TASE | ✅ |
| CMER.TA | 116598925 | DOLLR4LOT | ⚠️ Dollar-denominated |
| DLEKG.TA | 160213536 | TASE | ✅ |
| DORL.TA | 703187903 | TASE | ✅ |
| ENLT.TA | 613359894 | NASDAQ | ⚠️ Dual-listed |
| ENOG.TA | 310727935 | LSE | ⚠️ Dual-listed (London) |
| EQTL.TA | 491635666 | PINK | ⚠️ OTC listing |
| FIBI.TA | 160213262 | TASE | ✅ |
| FOX.TA | 356858007 | NASDAQ | ⚠️ Dual-listed |
| GAGR.TA | 160213826 | TASE | ✅ |
| GCT.TA | 579848128 | NASDAQ | ⚠️ Dual-listed |
| GLTL.TA | 107485989 | LSEETF | ⚠️ London ETF |
| HGGE.TA | 810082465 | TASE | ✅ |
| HIPR.TA | 548855892 | TASE | ✅ |
| IBI.TA | 603528847 | FWB2 | ⚠️ Frankfurt listing |
| IES.TA | 160212614 | TASE | ✅ |
| ILCO.TA | 160212974 | TASE | ✅ |
| IMCO.TA | 366248641 | TASE | ✅ |
| ISRS.TA | 160212850 | TASE | ✅ |
| KEN.TA | 179161051 | NYSE | ⚠️ Dual-listed |
| KRDI.TA | 325441411 | CORPACT | ⚠️ Corporate action |
| LAHAV.TA | 366247975 | TASE | ✅ |
| MGOR.TA | 160213899 | TASE | ✅ |
| MISH.TA | 160213077 | TASE | ✅ |
| MLTM.TA | 160213037 | TASE | ✅ |
| MNIF.TA | 465295199 | TASE | ✅ |
| MTAV.TA | 160213919 | TASE | ✅ |
| NFTA.TA | 160213369 | TASE | ✅ |
| NOFR.TA | 537567524 | TASE | ✅ |
| NVPT.TA | 572123572 | TASE | ✅ |
| NWMD.TA | 132489843 | DOLLR4LOT | ⚠️ Dollar-denominated |
| NXSN.TA | 522561580 | TASE | ✅ |
| NXTM.TA | 366247731 | TASE | ✅ |
| OPCE.TA | 340042883 | TASE | ✅ |
| PNRG.TA | 4816745 | NASDAQ | ⚠️ Dual-listed |
| PRIM.TA | 53509761 | NYSE | ⚠️ Dual-listed |
| QLTU.TA | 160212341 | TASE | ✅ |
| SHOM.TA | 52218707 | PINK | ⚠️ OTC listing |
| SLARL.TA | 419578374 | TASE | ✅ |
| SOFW.TA | 493427750 | TASE | ✅ |
| TLSY.TA | 160212796 | TASE | ✅ |
| TRX.TA | 564395786 | AMEX | ⚠️ Already in UNTRADEABLE |

---

## Potential Issues

**Dual-listed tickers (exchange mismatch):** The following TASE tickers have ConIDs pointing to non-TASE exchanges. This means IBKR will route orders to the foreign exchange (NASDAQ, NYSE, LSE) instead of TASE. If the intent is to trade them on TASE specifically, the ConID may need to be corrected.

| Ticker | Cached Exchange | Expected |
|--------|----------------|----------|
| AURA.TA | NASDAQ | TASE |
| CMER.TA | DOLLR4LOT | TASE |
| ENLT.TA | NASDAQ | TASE |
| ENOG.TA | LSE | TASE |
| EQTL.TA | PINK | TASE |
| FOX.TA | NASDAQ | TASE |
| GCT.TA | NASDAQ | TASE |
| GLTL.TA | LSEETF | TASE |
| IBI.TA | FWB2 | TASE |
| KEN.TA | NYSE | TASE |
| KRDI.TA | CORPACT | TASE |
| NWMD.TA | DOLLR4LOT | TASE |
| PNRG.TA | NASDAQ | TASE |
| PRIM.TA | NYSE | TASE |
| SHOM.TA | PINK | TASE |
| TRX.TA | AMEX | TASE |

> **Impact:** When Paper Lab sends a BUY order for these tickers, IBKR routes it to the foreign exchange. The price will be in USD (not ILS), which means the currency conversion logic may produce incorrect results. These tickers should either be re-resolved with TASE-specific ConIDs, or added to UNTRADEABLE_TICKERS.

---

## Recommendations

1. **Re-resolve dual-listed tickers** — Run ConidAutoFill with exchange filter "TASE" for the 16 mismatched tickers above.
2. **Monitor ACCL.TA and NTO.TA** — These may become available on IBKR in the future. Periodically retry resolution.
3. **Add KRDI.TA to UNTRADEABLE** — CORPACT exchange indicates a corporate action, not a tradeable security.
