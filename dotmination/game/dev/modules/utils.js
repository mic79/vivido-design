// Utility functions
function isEven(n) {
  return n % 2 == 0;
}

// Color utilities
window.hexToRgb = function(hex) {
  return hex.replace(/^#?([a-f\d])([a-f\d])([a-f\d])$/i
             ,(m, r, g, b) => '#' + r + r + g + g + b + b)
    .substring(1).match(/.{2}/g)
    .map(x => parseInt(x, 16));
};