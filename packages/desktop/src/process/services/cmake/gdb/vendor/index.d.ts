declare function parse(output: string): {
  resultRecord?: { token: string; class: string; result: unknown };
  outOfBandRecords: { token: string; class: string; outputType: string; result: unknown }[];
};
export default parse;
