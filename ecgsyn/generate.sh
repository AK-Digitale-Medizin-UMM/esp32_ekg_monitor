#!/bin/sh
set -eu

cd -- "$(dirname -- "$0")"
exec octave --quiet --no-gui generate.m
