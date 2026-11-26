import { useEffect, useRef, useState } from "react";

// React 18 does not bind change events on web components (s-select, s-choice-list): listen directly.
export function useChange(handler) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    el.addEventListener("change", handler);
    return () => el.removeEventListener("change", handler);
  });
  return ref;
}

// Smart-collection conditions (API 2026-10 collection sources), shared by the Collections pages.
export const FIELDS = [
  ["productType", "Product type", ["EQUALS", "NOT_EQUALS", "CONTAINS", "STARTS_WITH"]],
  ["productVendor", "Vendor", ["EQUALS", "NOT_EQUALS", "CONTAINS"]],
  ["productTag", "Tag", ["TAGGED_WITH", "NOT_TAGGED_WITH"]],
  ["productTitle", "Title", ["CONTAINS", "EQUALS", "STARTS_WITH", "DOES_NOT_CONTAIN"]],
  ["variantPrice", "Price", ["GREATER_THAN", "LESS_THAN", "EQUALS"]],
];
export const label = (r) => r.toLowerCase().replace(/_/g, " ");

// Field + relation + value inputs, shared with the collection page ("Add condition").
export function ConditionFields() {
  const [field, setField] = useState("productType");
  const relations = FIELDS.find((f) => f[0] === field)[2];
  const fieldRef = useChange((e) => setField(e.currentTarget.value));
  return (
    <s-grid gridTemplateColumns="1fr 1fr 1fr" gap="base">
      <s-select ref={fieldRef} name="field" label="Field" value={field}>
        {FIELDS.map(([v, l]) => <s-option key={v} value={v}>{l}</s-option>)}
      </s-select>
      <s-select name="relation" label="Condition" key={field}>
        {relations.map((r) => <s-option key={r} value={r}>{label(r)}</s-option>)}
      </s-select>
      <s-text-field name="value" label="Value" required
                    placeholder={field === "variantPrice" ? "30.00" : "Shirts, Pants"} />
    </s-grid>
  );
}


// One form row → one inclusion condition, e.g. { productType: { relation: "EQUALS", values: ["Shirts"], matchType: "ANY" } }
export const toCondition = ({ field, relation, value }, currency) => {
  if (field === "variantPrice") return { variantPrice: { relation, value: { amount: value, currencyCode: currency } } };
  const values = value.split(",").map((v) => v.trim()).filter(Boolean);
  return { [field]: { relation, values, matchType: "ANY" } };
};


// GraphQL fields to read conditions back (each condition type is its own object type).
export const CONDITION_FIELDS = `
  __typename id
  ... on CollectionSourceInclusionConditionProductType { relation values }
  ... on CollectionSourceInclusionConditionProductVendor { relation values }
  ... on CollectionSourceInclusionConditionProductTag { relation values }
  ... on CollectionSourceInclusionConditionProductTitle { relation values }
  ... on CollectionSourceInclusionConditionVariantPrice { relation value { amount currencyCode } }`;

// "Product type equals Shirts, Pants" / "Price greater than 30.0 USD"
export const describe = (c) => {
  const key = c.__typename.replace("CollectionSourceInclusionCondition", "");
  const name = FIELDS.find((f) => f[0].toLowerCase() === key.toLowerCase())?.[1] || key;
  const what = c.values ? c.values.join(", ") : c.value ? `${c.value.amount} ${c.value.currencyCode}` : "";
  return `${name} ${label(c.relation || "")} ${what}`;
};
