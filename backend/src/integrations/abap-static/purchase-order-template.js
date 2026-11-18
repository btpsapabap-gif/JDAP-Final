import { expectedReportName } from "./draft-quality.js";

export function isS4PurchaseOrderReportRequest(prompt = "", system = {}) {
  const target = `${system.id || ""} ${system.name || ""} ${system.type || ""} ${system.release || ""}`;
  const task = String(prompt || "");
  return /s\/4|s4hana/i.test(target)
    && /(?:purchase\s+orders?|\bPO\b)/i.test(task)
    && /\bheader\b/i.test(task)
    && /\bitems?\b/i.test(task)
    && /\b(?:report|extract|display|list|show)\b/i.test(task);
}

export function buildS4PurchaseOrderReportTemplate(prompt = "", fallbackReportName = null) {
  const reportName = expectedReportName(prompt) || fallbackReportName || "Z_PO_HEADER_ITEMS";
  return `REPORT ${reportName.toLowerCase()} LINE-SIZE 280 NO STANDARD PAGE HEADING.

* S/4HANA report using SAP purchase-order API CDS views.
* Confirm the views, selected elements, DCL behavior, and release contracts
* in the target S/4HANA 2023 system using SAP syntax check and Clean Core ATC.
* Company-code authorization behavior must be confirmed against target roles.

CONSTANTS gc_max_rows TYPE i VALUE 501.

DATA gv_po_date TYPE i_purchaseorderapi01-purchaseorderdate.
DATA gv_po_number TYPE i_purchaseorderapi01-purchaseorder.
DATA gv_supplier TYPE i_purchaseorderapi01-supplier.
DATA gv_material TYPE i_purchaseorderitemapi01-material.
DATA gv_plant TYPE i_purchaseorderitemapi01-plant.

PARAMETERS p_bukrs TYPE i_purchaseorderapi01-companycode OBLIGATORY.
PARAMETERS p_ekorg TYPE i_purchaseorderapi01-purchasingorganization OBLIGATORY.
SELECT-OPTIONS s_bedat FOR gv_po_date OBLIGATORY NO-EXTENSION.
SELECT-OPTIONS s_ebeln FOR gv_po_number NO-EXTENSION.
SELECT-OPTIONS s_lifnr FOR gv_supplier NO-EXTENSION.
SELECT-OPTIONS s_matnr FOR gv_material NO-EXTENSION.
SELECT-OPTIONS s_werks FOR gv_plant NO-EXTENSION.

START-OF-SELECTION.
  IF lines( s_bedat ) <> 1.
    MESSAGE 'Enter one inclusive purchase-order date interval.' TYPE 'E'.
  ENDIF.

  IF s_bedat[ 1 ]-sign <> 'I' OR s_bedat[ 1 ]-option <> 'BT'.
    MESSAGE 'Enter one inclusive purchase-order date interval.' TYPE 'E'.
  ENDIF.

  IF s_bedat[ 1 ]-high < s_bedat[ 1 ]-low
      OR s_bedat[ 1 ]-high - s_bedat[ 1 ]-low > 365.
    MESSAGE 'Purchase-order date interval must not exceed 366 days.' TYPE 'E'.
  ENDIF.

  AUTHORITY-CHECK OBJECT 'M_BEST_EKO'
    ID 'EKORG' FIELD p_ekorg
    ID 'ACTVT' FIELD '03'.
  IF sy-subrc <> 0.
    MESSAGE 'Not authorized to display purchase orders for this purchasing organization.' TYPE 'E'.
  ENDIF.

  SELECT FROM I_PurchaseOrderAPI01 AS Header
    INNER JOIN I_PurchaseOrderItemAPI01 AS Item
      ON Item~PurchaseOrder = Header~PurchaseOrder
    LEFT OUTER JOIN I_Supplier AS Supplier
      ON Supplier~Supplier = Header~Supplier
    FIELDS Header~PurchaseOrder,
           Header~CompanyCode,
           Header~PurchasingOrganization,
           Header~PurchasingGroup,
           Header~PurchaseOrderType,
           Header~PurchaseOrderDate,
           Header~Supplier,
           Supplier~SupplierName,
           Item~PurchaseOrderItem,
           Item~Material,
           Item~PurchaseOrderItemText,
           Item~Plant,
           Item~StorageLocation,
           Item~OrderQuantity,
           Item~PurchaseOrderQuantityUnit,
           Item~NetPriceAmount,
           Item~NetPriceQuantity,
           Item~NetAmount,
           Item~DocumentCurrency
    WHERE Header~CompanyCode = @p_bukrs
      AND Header~PurchasingOrganization = @p_ekorg
      AND Header~PurchaseOrderDate IN @s_bedat
      AND Header~PurchaseOrder IN @s_ebeln
      AND Header~Supplier IN @s_lifnr
      AND Item~Material IN @s_matnr
      AND Item~Plant IN @s_werks
      AND Item~PurchasingDocumentDeletionCode = ''
    ORDER BY Header~PurchaseOrder, Item~PurchaseOrderItem
    INTO TABLE @DATA(lt_po_items)
    UP TO @gc_max_rows ROWS.

  IF lt_po_items IS INITIAL.
    WRITE: / 'No purchase-order items match the selection.'.
    RETURN.
  ENDIF.

  IF lines( lt_po_items ) = gc_max_rows.
    MESSAGE 'More than 500 items match. Narrow the selection and run again.' TYPE 'E'.
  ENDIF.

  WRITE: / 'PO', 14 'Company', 25 'Purch. org.', 38 'Purch. group',
           52 'Type', 62 'Date', 75 'Supplier', 91 'Supplier name',
           126 'Item', 136 'Material', 153 'Short text', 186 'Plant',
           195 'SLoc', 202 'Quantity', 214 'Unit', 225 'Net price',
           241 'Net amount', 258 'Curr.'.
  LOOP AT lt_po_items INTO DATA(ls_po_item).
    WRITE: / ls_po_item-PurchaseOrder,
             ls_po_item-CompanyCode,
             ls_po_item-PurchasingOrganization,
             ls_po_item-PurchasingGroup,
             ls_po_item-PurchaseOrderType,
             ls_po_item-PurchaseOrderDate,
             ls_po_item-Supplier,
             ls_po_item-SupplierName,
             ls_po_item-PurchaseOrderItem,
             ls_po_item-Material,
             ls_po_item-PurchaseOrderItemText,
             ls_po_item-Plant,
             ls_po_item-StorageLocation,
             ls_po_item-OrderQuantity,
             ls_po_item-PurchaseOrderQuantityUnit,
             ls_po_item-NetPriceAmount,
             ls_po_item-NetPriceQuantity,
             ls_po_item-NetAmount,
             ls_po_item-DocumentCurrency.
  ENDLOOP.

* The API CDS views apply their DCL restrictions. Confirm the target system's
* company-code authorization design and role assignments before use.`;
}
