pkg load signal;
rng(1, 'twister');

sample_rate = 256;
sample_count = 60 * sample_rate;
% Generate a little extra to allow for beat-to-beat variation.
[amplitude, peaks] = ecgsyn(sample_rate, 64, 0, 60, 1, 0.5, sample_rate);
if numel(amplitude) < sample_count || numel(peaks) < sample_count
    error('ECGSYN returned fewer than %d samples', sample_count);
end

samples = (1:sample_count)';
time = (samples - 1) / sample_rate;
dlmwrite('ecgsyn.dat', [time, amplitude(samples), peaks(samples)], ...
         'delimiter', ' ', 'precision', '%.12g');
