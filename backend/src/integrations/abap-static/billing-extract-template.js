import { expectedReportName } from "./draft-quality.js";

/**
 * Use a deterministic, reviewable S/4 billing extraction draft for this known
 * request shape. This avoids asking a small local model to invent DDIC names.
 */
export function isS4BillingExtractRequest(prompt = "", system = {}) {
  const target = `${system.id || ""} ${system.name || ""} ${system.type || ""} ${system.release || ""}`;
  const task = String(prompt);
  return /s\/4|s4hana/i.test(target)
    && /billing document/i.test(task)
    && /header/i.test(task)
    && /item/i.test(task)
    && /billing date/i.test(task)
    && /sold.to party/i.test(task)
    && /sales organization/i.test(task);
}

export function buildS4BillingExtractTemplate(prompt = "", fallbackReportName = null) {
  const reportName = expectedReportName(prompt) || fallbackReportName || "Z_JDAP_BILLING_EXTRACT";
  return `REPORT ${reportName.toLowerCase()} LINE-SIZE 180 NO STANDARD PAGE HEADING.

* S/4HANA draft: uses billing CDS views rather than direct VBRK/VBRP reads.
* Verify view and field release contracts with the target system's ATC/API state.
* The CDS authorization model and this explicit sales-org check both require
* confirmation against the target system's authorization design.

CONSTANTS gc_max_rows TYPE i VALUE 501.

DATA gv_billing_date TYPE i_billingdocumentbasic-billingdocumentdate.
DATA gv_billing_doc TYPE i_billingdocumentbasic-billingdocument.
DATA gv_sold_to TYPE i_billingdocumentbasic-soldtoparty.
DATA gv_sales_org TYPE i_billingdocumentbasic-salesorganization.
DATA gv_product_display TYPE c LENGTH 18.
DATA gv_description_display TYPE c LENGTH 38.

SELECT-OPTIONS s_fkdat FOR gv_billing_date OBLIGATORY NO-EXTENSION.
SELECT-OPTIONS s_vbeln FOR gv_billing_doc NO-EXTENSION.
SELECT-OPTIONS s_kunag FOR gv_sold_to NO-EXTENSION.
PARAMETERS p_vkorg TYPE i_billingdocumentbasic-salesorganization OBLIGATORY.

START-OF-SELECTION.
  IF lines( s_fkdat ) <> 1.
    MESSAGE 'Enter one inclusive billing-date interval.' TYPE 'E'.
  ENDIF.

  IF s_fkdat[ 1 ]-sign <> 'I' OR s_fkdat[ 1 ]-option <> 'BT'.
    MESSAGE 'Enter one inclusive billing-date interval.' TYPE 'E'.
  ENDIF.

  IF s_fkdat[ 1 ]-high < s_fkdat[ 1 ]-low
      OR s_fkdat[ 1 ]-high - s_fkdat[ 1 ]-low > 365.
    MESSAGE 'Billing-date interval must not exceed 366 days.' TYPE 'E'.
  ENDIF.

  AUTHORITY-CHECK OBJECT 'V_VBRK_VKO'
    ID 'VKORG' FIELD p_vkorg
    ID 'ACTVT' FIELD '03'.
  IF sy-subrc <> 0.
    MESSAGE 'Not authorized to display billing documents for this sales organization.' TYPE 'E'.
  ENDIF.

  SELECT FROM I_BillingDocumentBasic AS Header
    INNER JOIN I_BillingDocumentItemBasic AS Item
      ON Item~BillingDocument = Header~BillingDocument
    FIELDS Header~BillingDocument,
           Header~BillingDocumentDate,
           Header~SoldToParty,
           Header~SalesOrganization,
           Header~TransactionCurrency,
           Item~BillingDocumentItem,
           Item~Product,
           Item~BillingDocumentItemText,
           Item~BillingQuantity,
           Item~BillingQuantityUnit,
           Item~NetAmount
    WHERE Header~BillingDocumentDate IN @s_fkdat
      AND Header~BillingDocument IN @s_vbeln
      AND Header~SoldToParty IN @s_kunag
      AND Header~SalesOrganization = @p_vkorg
      AND Header~BillingDocumentIsTemporary = ''
    ORDER BY Header~BillingDocument, Item~BillingDocumentItem
    INTO TABLE @DATA(lt_billing)
    UP TO @gc_max_rows ROWS.

  IF lt_billing IS INITIAL.
    WRITE: / 'No billing documents match the selection.'.
    RETURN.
  ENDIF.

  IF lines( lt_billing ) = gc_max_rows.
    MESSAGE 'More than 500 rows match. Narrow the selection and run again.' TYPE 'E'.
  ENDIF.

  WRITE: /1 'Billing doc.',
           14 'Date',
           26 'Sold-to',
           38 'Sales org.',
           50 'Item',
           58 'Product',
           78 'Description',
           118 'Quantity',
           136 'Unit',
           143 'Net value',
           160 'Curr.'.
  LOOP AT lt_billing INTO DATA(ls_billing).
    gv_product_display = ls_billing-Product.
    gv_description_display = ls_billing-BillingDocumentItemText.
    WRITE: /1 ls_billing-BillingDocument,
             14 ls_billing-BillingDocumentDate,
             26 ls_billing-SoldToParty,
             38 ls_billing-SalesOrganization,
             50 ls_billing-BillingDocumentItem,
             58 gv_product_display,
             78 gv_description_display,
             118 ls_billing-BillingQuantity,
             136 ls_billing-BillingQuantityUnit,
             143 ls_billing-NetAmount,
             160 ls_billing-TransactionCurrency.
  ENDLOOP.`;
}
