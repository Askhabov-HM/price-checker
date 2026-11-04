package ru.pricechecker.lamoda;

import java.util.Collection;
import java.util.HashSet;
import java.util.Set;

final class DiagnosticDelivery {
    private DiagnosticDelivery(){}
    static Set<String> confirmed(Collection<String> sent,Collection<String> acknowledgement) {
        Set<String> result=new HashSet<>(sent);result.retainAll(acknowledgement);return result;
    }
}
