/** Invented bills. Every person, clinic, number and address here is made up. */
export interface Sample { id: string; title: string; blurb: string; text: string }

export const SAMPLES: Sample[] = [
  {
    id: 'er',
    title: 'Emergency room visit',
    blurb: 'A hospital statement with a duplicate charge and an out-of-network doctor.',
    text: `LAKEMONT REGIONAL MEDICAL CENTER
Patient Financial Services
4100 Harbor View Parkway, Marlow, OH 44511
Billing questions: (330) 555-0142

STATEMENT DATE: 10/28/2026                 PAY BY: 11/27/2026

Patient: Maria Delgado                     Account Number: 7741-208-3391
Date of Birth: 03/14/1984                  MRN: 00482917
Guarantor: Maria Delgado
218 Alder Creek Lane, Apt 4B
Marlow, OH 44512

Insurance: Buckeye Mutual PPO              Member ID: BKM904417726
Group Number: 0057731                      Claim Number: 26-3381-99047

DATE OF SERVICE: 09/19/2026   EMERGENCY DEPARTMENT

CODE     DESCRIPTION                                   QTY     CHARGE
99285    ED VISIT LEVEL 5 HIGH COMPLEXITY               1    2,840.00
99285    ED VISIT LEVEL 5 HIGH COMPLEXITY               1    2,840.00
71046    XR CHEST 2 VIEWS                               1      412.00
93005    ECG TRACING ONLY                               1      186.00
80053    COMPREHENSIVE METABOLIC PANEL                  1      274.00
85025    CBC W AUTO DIFF                                1      139.00
96374    IV PUSH SINGLE DRUG                            1      398.00
J1885    KETOROLAC 15MG INJ                             2       96.00
A9270    NON-COVERED SUPPLY                             1       64.00
99053    AFTER HOURS SERVICE 10PM-8AM                   1      210.00

TOTAL CHARGES                                               7,459.00
INSURANCE PAYMENTS                                         -2,115.40
CONTRACTUAL ADJUSTMENT                                     -1,892.60
PATIENT BALANCE DUE                                         3,451.00

NOTE: Physician services by Dr. Alan Whitcombe (Summit Emergency
Physicians Group) are billed separately and were processed as
OUT OF NETWORK. Ms. Delgado, please remit payment or call our office.

Payment plans available. Balances unpaid after 60 days may be referred
to collections. Questions: billing@lakemontregional.example`,
  },
  {
    id: 'eob',
    title: 'Explanation of benefits',
    blurb: 'An insurer notice denying a routine lab as "not medically necessary".',
    text: `BUCKEYE MUTUAL HEALTH PLAN
EXPLANATION OF BENEFITS - THIS IS NOT A BILL

Member: James R. Okafor                    Member ID: BKM771204583
Subscriber: Priya Okafor                   Group No: 0091442
6027 Tanager Court
Fairlawn, OH 44333                         Claim No: 26-4410-22871

Provider: Cedar Hollow Family Practice     Patient ID: P-558201
Rendering: Dr. Helen Marsh
Date of Service: 08/04/2026                Processed: 08/29/2026

CODE     SERVICE                      BILLED   ALLOWED  PLAN PAID  YOU OWE  REMARK
99396    PREVENTIVE VISIT 40-64       310.00   228.00    228.00      0.00
80061    LIPID PANEL                   96.00    22.00     22.00      0.00
83036    HEMOGLOBIN A1C                88.00     0.00      0.00     88.00   N115
82306    VITAMIN D 25 HYDROXY         142.00     0.00      0.00    142.00   CO-50
36415    VENIPUNCTURE                  24.00     3.00      3.00      0.00
99214    OFFICE VISIT EST LEVEL 4     245.00   164.00    124.00     40.00   PR-3

TOTALS                                905.00   417.00    377.00    270.00

REMARK CODES
N115   Decision based on a Local Coverage Determination.
CO-50  Non-covered: not deemed a medical necessity by the payer.
PR-3   Copayment amount.

You may appeal within 180 days of this notice. James Okafor or an
authorized representative may call Member Services at 800-555-0199.`,
  },
  {
    id: 'ambulance',
    title: 'Ambulance invoice',
    blurb: 'A ground ambulance bill sent before insurance was ever billed.',
    text: `TRI-COUNTY EMS BILLING
PO Box 88120, Dayton, OH 45401            Phone (937) 555-0177

INVOICE #: TC-2026-118842                  Invoice Date: 10/02/2026
Bill To: Robert Nakamura
1509 W Sycamore St
Kettering, OH 45429
DOB: 11/02/1957     SSN: ***-**-4471     Email: r.nakamura57@mailbox.example

Transport Date: 09/11/2026   From: residence   To: Miami Valley General ED
Incident No: 26-091187      Insurance on file: NONE PROVIDED

HCPCS    DESCRIPTION                          UNITS      AMOUNT
A0427    ALS1 EMERGENCY TRANSPORT               1       1,385.00
A0425    GROUND MILEAGE PER MILE               11         264.00
A0398    ALS ROUTINE DISPOSABLE SUPPLIES        1         118.00
A0422    OXYGEN AND SUPPLIES                    1          92.00
         LATE FEE                               1          35.00

AMOUNT DUE NOW                                          1,894.00

Mr. Nakamura, our records show no insurance was billed for this
transport. If you have Medicare or other coverage, contact us.`,
  },
];
